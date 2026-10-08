import { v2 as cloudinary } from 'cloudinary';
import { getEnvironment } from '../config/environment.js';
import { AppError } from '../errors/AppError.js';

export interface MediaService {
  createUploadSignature(): {
    timestamp: number;
    signature: string;
    cloudName: string;
    apiKey: string;
    folder: string;
  };
  destroy(publicId: string): Promise<void>;
  uploadFile(path: string, publicId: string): Promise<{ publicId: string; src: string }>;
}

function configure(): { folder: string; cloudName: string; apiKey: string; apiSecret: string } {
  const environment = getEnvironment();
  if (!environment.CLOUDINARY_CLOUD_NAME || !environment.CLOUDINARY_API_KEY || !environment.CLOUDINARY_API_SECRET) {
    throw new AppError(503, 'MEDIA_NOT_CONFIGURED', 'Cloudinary is not configured.');
  }
  cloudinary.config({
    cloud_name: environment.CLOUDINARY_CLOUD_NAME,
    api_key: environment.CLOUDINARY_API_KEY,
    api_secret: environment.CLOUDINARY_API_SECRET,
    secure: true,
  });
  return {
    folder: environment.CLOUDINARY_FOLDER,
    cloudName: environment.CLOUDINARY_CLOUD_NAME,
    apiKey: environment.CLOUDINARY_API_KEY,
    apiSecret: environment.CLOUDINARY_API_SECRET,
  };
}

export const cloudinaryMediaService: MediaService = {
  createUploadSignature() {
    const configuration = configure();
    const timestamp = Math.floor(Date.now() / 1000);
    return {
      timestamp,
      folder: configuration.folder,
      cloudName: configuration.cloudName,
      apiKey: configuration.apiKey,
      signature: cloudinary.utils.api_sign_request(
        { folder: configuration.folder, timestamp },
        configuration.apiSecret,
      ),
    };
  },

  async destroy(publicId) {
    const { folder } = configure();
    if (!publicId.startsWith(`${folder}/`)) {
      throw new AppError(400, 'INVALID_MEDIA_ASSET', 'The asset is outside the Kawama media folder.');
    }
    await cloudinary.uploader.destroy(publicId, { invalidate: true, resource_type: 'image' });
  },

  async uploadFile(path, publicId) {
    const { folder } = configure();
    const result = await cloudinary.uploader.upload(path, {
      folder,
      public_id: publicId,
      overwrite: false,
      resource_type: 'image',
    });
    return { publicId: result.public_id, src: result.secure_url };
  },
};
