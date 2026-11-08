export function detectKind(name) {
  const ext = String(name).split('.').pop().toLowerCase();
  if (['json', 'jsonc', 'json5'].includes(ext)) return 'json';
  if (['yaml', 'yml'].includes(ext)) return 'yaml';
  if (['xml', 'svg'].includes(ext)) return 'xml';
  if (['csv', 'tsv'].includes(ext)) return 'csv';
  return 'text';
}

export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return value.toFixed(index === 0 ? 0 : 1) + ' ' + units[index];
}

console.log(detectKind('demo.json'), formatBytes(274));
