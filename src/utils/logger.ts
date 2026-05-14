export const log = {
  info: (msg: string, ...args: unknown[]) =>
    process.stderr.write(`[INFO] ${msg}${args.length ? ' ' + args.map(String).join(' ') : ''}\n`),
  warn: (msg: string) => process.stderr.write(`[WARN] ${msg}\n`),
  error: (msg: string, err?: unknown) =>
    process.stderr.write(`[ERROR] ${msg}${err != null ? ': ' + (err instanceof Error ? err.message : String(err)) : ''}\n`),
};
