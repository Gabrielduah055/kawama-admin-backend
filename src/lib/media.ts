import { getEnvironment } from '../config/environment.js';

interface MediaReference {
  publicId?: string | undefined;
  src: string;
}

function isSeedAssetUrl(source: string, baseUrl: string): boolean {
  try {
    const sourceUrl = new URL(source);
    const base = new URL(baseUrl);
    const basePath = base.pathname.replace(/\/$/, '');
    return sourceUrl.origin === base.origin
      && (sourceUrl.pathname === basePath || sourceUrl.pathname.startsWith(`${basePath}/`));
  } catch {
    return false;
  }
}

export function isManagedMedia(reference: MediaReference): boolean {
  const environment = getEnvironment();
  if (reference.publicId?.startsWith(`${environment.CLOUDINARY_FOLDER}/`)) return true;
  return Boolean(
    environment.SEED_ASSET_BASE_URL
      && isSeedAssetUrl(reference.src, environment.SEED_ASSET_BASE_URL),
  );
}
