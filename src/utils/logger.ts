type Metadata = Record<string, string | number | boolean | undefined>;

const write = (level: 'info' | 'error', message: string, metadata?: Metadata): void => {
  const entry = { level, message, ...(metadata ? { metadata } : {}), timestamp: new Date().toISOString() };
  if (level === 'error') console.error(JSON.stringify(entry));
  else console.log(JSON.stringify(entry));
};

export const logger = {
  info: (message: string, metadata?: Metadata): void => write('info', message, metadata),
  error: (message: string, metadata?: Metadata): void => write('error', message, metadata),
};
