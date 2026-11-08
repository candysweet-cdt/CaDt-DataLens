type FormatId = 'json' | 'yaml' | 'xml' | 'csv' | 'text' | 'bytes';

interface SampleEntry {
  id: FormatId;
  name: string;
  extensions: string[];
  rawOnly?: boolean;
}

const formats: SampleEntry[] = [
  { id: 'json', name: 'JSON', extensions: ['json', 'jsonc', 'json5'] },
  { id: 'yaml', name: 'YAML', extensions: ['yaml', 'yml'] },
  { id: 'xml', name: 'XML', extensions: ['xml', 'svg'] },
  { id: 'csv', name: 'CSV', extensions: ['csv', 'tsv'] },
  { id: 'text', name: '纯文本', extensions: ['txt', 'md', 'log'], rawOnly: true },
];

export function findFormat(name: string): SampleEntry | undefined {
  const ext = name.split('.').pop()?.toLowerCase();
  return formats.find((entry) => entry.extensions.includes(ext || ''));
}
