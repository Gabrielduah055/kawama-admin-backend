export interface BuildMetadata {
  version: string;
  commit: string | null;
}

export function getBuildMetadata(): BuildMetadata {
  const candidate = [
    process.env.RENDER_GIT_COMMIT,
    process.env.GIT_COMMIT,
    process.env.SOURCE_VERSION,
  ].find((value) => typeof value === 'string' && /^[a-f\d]{7,64}$/i.test(value.trim()));
  return {
    version: '1.0.0',
    commit: candidate?.trim() ?? null,
  };
}
