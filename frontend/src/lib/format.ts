export function formatBytes(bytes: number): string {
  const MB = 1024 * 1024;
  const GB = MB * 1024;
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)}GB`;
  return `${(bytes / MB).toFixed(1)}MB`;
}
