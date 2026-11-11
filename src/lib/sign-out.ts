export async function signOutAndLeave(deps: {
  signOut: () => Promise<{ error: unknown }>;
  leave: () => void;
}): Promise<boolean> {
  try {
    const { error } = await deps.signOut();
    if (error) return false;
  } catch {
    return false;
  }
  deps.leave();
  return true;
}
