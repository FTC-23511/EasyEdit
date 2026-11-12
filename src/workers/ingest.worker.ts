// Reads a file the member chose, and makes a video's preview copy and the still picture.
// Runs in a Web Worker so the page stays responsive. It holds no secret and makes no network request.
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSink,
  Conversion,
  ConversionCanceledError,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  type DiscardedTrack,
  type InputVideoTrack,
  type StreamTargetChunk,
} from "mediabunny";
import type { Derived, IngestEvent, IngestRequest, PreviewProblem } from "@/lib/media/ingest-protocol";
import { POSTER, PREVIEW, posterSize, posterTime, previewFps, previewSize } from "@/lib/media/preview-spec";
import { kindFromName } from "@/lib/media/rules";
import type { AssetProbe } from "@/lib/media/types";

type DeriveRequest = Extract<IngestRequest, { type: "derive" }>;

// A derive request that has not been answered yet. `conversion` is set while the preview copy is being made.
type Job = { canceled: boolean; conversion: Conversion | null };
const jobs = new Map<string, Job>();

const post = (event: IngestEvent) => self.postMessage(event);

// ---- Reading a file ----

// A video's or an audio file's facts, or null when the file is neither.
async function probeMedia(file: Blob): Promise<AssetProbe | null> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    if (!(await input.canRead())) return null;
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    if (!video && !audio) return null;
    const durationMs = Math.round((await input.computeDuration()) * 1000);
    if (!video) return { kind: "audio", durationMs, width: null, height: null, fps: null, hasAudio: true, videoCodec: null };

    const rate = (await video.computePacketStats(100)).averagePacketRate;
    return {
      kind: "video",
      durationMs,
      // As shown: after the pixel shape and the rotation, so these are never swapped. Whole numbers, as the library stores them.
      width: Math.round(await video.getDisplayWidth()),
      height: Math.round(await video.getDisplayHeight()),
      fps: Number.isFinite(rate) && rate > 0 ? Math.round(rate * 100) / 100 : null,
      hasAudio: audio !== null,
      videoCodec: await video.getCodec(),
    };
  } finally {
    input.dispose();
  }
}

async function probe(file: Blob, fileName: string): Promise<AssetProbe | null> {
  const media = await probeMedia(file);
  if (media) return media;
  if (kindFromName(fileName) !== "image") return null;
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  bitmap.close();
  return { kind: "image", durationMs: null, width, height, fps: null, hasAudio: false, videoCodec: null };
}

// ---- The still picture ----

const toJpeg = (canvas: OffscreenCanvas) => canvas.convertToBlob({ type: "image/jpeg", quality: POSTER.quality });

// One frame of the video. Null when the frame cannot be decoded.
async function videoPoster(track: InputVideoTrack, width: number, height: number, durationMs: number): Promise<Blob | null> {
  try {
    // The size already has the video's shape; "fill" lets it cover the whole picture where rounding to even sides moved an edge.
    const sink = new CanvasSink(track, { ...posterSize(width, height), fit: "fill" });
    const frame = await sink.getCanvas(posterTime(durationMs));
    // In a worker the sink only ever makes an OffscreenCanvas.
    return frame && frame.canvas instanceof OffscreenCanvas ? await toJpeg(frame.canvas) : null;
  } catch {
    return null;
  }
}

// The image itself, drawn small. Null when the image cannot be decoded.
async function imagePoster(file: Blob): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const { width, height } = posterSize(bitmap.width, bitmap.height);
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.drawImage(bitmap, 0, 0, width, height);
      return await toJpeg(canvas);
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

// ---- The preview copy ----

// The project's `lib` does not declare the sync access handle a worker gets; these are the three members used here.
type SyncAccessHandle = { write(data: Uint8Array, options?: { at?: number }): number; flush(): void; close(): void };
type SyncFileHandle = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncAccessHandle> };

const TEMP_FOLDER = "ingest";

// Where a preview copy is written while it is made.
type TempFile = {
  target: StreamTarget | BufferTarget;
  finish(): Promise<Blob>; // the finished copy; its file stays, because the page is still sending it
  discard(): Promise<void>; // removes what was written; never throws
};

// A file in the Origin Private File System, written piece by piece at each piece's position, so a long video is
// never held in memory. Where that storage is missing, the copy is held in memory instead.
async function openTempFile(id: string): Promise<TempFile> {
  try {
    const root = await navigator.storage.getDirectory();
    const folder = await root.getDirectoryHandle(TEMP_FOLDER, { create: true });
    const name = `${id}.mp4`;
    const handle = (await folder.getFileHandle(name, { create: true })) as SyncFileHandle;
    const access = await handle.createSyncAccessHandle();
    let open = true;
    const close = () => {
      if (!open) return;
      open = false;
      access.flush();
      access.close();
    };
    const writable = new WritableStream<StreamTargetChunk>({
      write(chunk) {
        if (!open) return; // a piece still on its way after a cancel
        if (access.write(chunk.data, { at: chunk.position }) !== chunk.data.byteLength) throw new Error("The preview copy could not be written.");
      },
      close,
      abort: close,
    });
    return {
      target: new StreamTarget(writable),
      async finish() {
        close();
        return handle.getFile();
      },
      async discard() {
        try {
          close();
          await folder.removeEntry(name);
        } catch {
          // Nothing more to do here: a file left behind is cleared later, with the other old ones in this folder.
        }
      },
    };
  } catch {
    const target = new BufferTarget();
    return {
      target,
      async finish() {
        if (!target.buffer) throw new Error("The preview copy was not finished.");
        return new Blob([target.buffer], { type: "video/mp4" });
      },
      async discard() {},
    };
  }
}

function problemFor(reason: DiscardedTrack["reason"]): PreviewProblem {
  if (reason === "undecodable_source_codec") return "cannot-decode";
  if (reason === "no_encodable_target_codec") return "cannot-encode";
  return "failed";
}

// The 720p H.264 and AAC copy of a video. Throws a ConversionCanceledError when the request was canceled;
// every other failure is an answer with no copy and the reason.
async function previewCopy(id: string, input: Input, width: number, height: number, fps: number | null, job: Job): Promise<Pick<Derived, "preview" | "previewProblem">> {
  if (job.canceled) throw new ConversionCanceledError();
  const temp = await openTempFile(id);
  try {
    const conversion = await Conversion.init({
      input,
      output: new Output({ format: new Mp4OutputFormat(), target: temp.target }),
      video: {
        ...previewSize(width, height),
        fit: "contain",
        frameRate: previewFps(fps),
        codec: "avc",
        quality: new Quality({ bitrate: PREVIEW.videoBitrate }),
        keyFrameInterval: PREVIEW.keyFrameSeconds,
        allowTransformationMetadata: false, // the rotation is drawn into the frames, so the copy plays upright anywhere
      },
      audio: {
        codec: "aac",
        quality: new Quality({ bitrate: PREVIEW.audioBitrate }),
        numberOfChannels: PREVIEW.audioChannels,
        sampleRate: PREVIEW.audioSampleRate,
      },
    });
    if (job.canceled) throw new ConversionCanceledError();

    // A conversion that lost its video but kept its audio still counts as valid, so the list is read either way.
    // A lost audio track alone is not a problem: the copy is silent.
    const lostVideo = conversion.discardedTracks.find((entry) => entry.track.type === "video");
    if (lostVideo) {
      await temp.discard();
      return { preview: null, previewProblem: problemFor(lostVideo.reason) };
    }

    job.conversion = conversion;
    let percent = -1;
    conversion.onProgress = (fraction) => {
      // The conversion reports after every frame; the page is told once per whole percent.
      const now = Math.floor(fraction * 100);
      if (now === percent) return;
      percent = now;
      post({ type: "progress", id, fraction });
    };
    await conversion.execute();
    const preview = await temp.finish();
    if (job.canceled) throw new ConversionCanceledError();
    return { preview, previewProblem: null };
  } catch (error) {
    await temp.discard();
    if (error instanceof ConversionCanceledError) throw error;
    return { preview: null, previewProblem: "failed" };
  } finally {
    job.conversion = null;
  }
}

// ---- Answering the page ----

async function derive({ id, file, probe: facts }: DeriveRequest, job: Job): Promise<Derived> {
  if (facts.kind === "audio") return { preview: null, poster: null, previewProblem: null };
  if (facts.kind === "image") return { preview: null, poster: await imagePoster(file), previewProblem: null };

  const { width, height, durationMs } = facts;
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || width === null || height === null || durationMs === null) return { preview: null, poster: null, previewProblem: "failed" };
    const poster = await videoPoster(track, width, height, durationMs);
    return { poster, ...(await previewCopy(id, input, width, height, facts.fps, job)) };
  } finally {
    input.dispose();
  }
}

async function answerProbe({ id, file, fileName }: Extract<IngestRequest, { type: "probe" }>): Promise<void> {
  let facts: AssetProbe | null = null;
  try {
    facts = await probe(file, fileName);
  } catch {
    // Anything that goes wrong while reading means the file cannot be read.
  }
  post(facts ? { type: "probed", id, probe: facts } : { type: "unreadable", id });
}

async function answerDerive(request: DeriveRequest): Promise<void> {
  const job: Job = { canceled: false, conversion: null };
  jobs.set(request.id, job);
  let derived: Derived | null;
  try {
    derived = await derive(request, job);
  } catch (error) {
    derived = error instanceof ConversionCanceledError ? null : { preview: null, poster: null, previewProblem: request.probe.kind === "video" ? "failed" : null };
  }
  jobs.delete(request.id);
  if (derived && !job.canceled) post({ type: "derived", id: request.id, ...derived });
}

// Stops the conversion; its temporary file is removed where the conversion ends. A request that was already
// answered is not here any more, so its finished file stays.
function cancel(id: string): void {
  const job = jobs.get(id);
  if (!job) return;
  job.canceled = true;
  void job.conversion?.cancel().catch(() => {});
}

self.addEventListener("message", (event: MessageEvent<IngestRequest>) => {
  const request = event.data;
  if (request.type === "probe") void answerProbe(request);
  else if (request.type === "derive") void answerDerive(request);
  else cancel(request.id);
});
