declare global {
  namespace Express {
    interface Request {
      id: string;
      admin?: { uid: string; email: string };
      rawBody?: Buffer;
    }
  }
}

export {};
