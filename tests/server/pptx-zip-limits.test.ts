import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { parseZip } from '../../packages/@openmaic/importer/src/parser/ZipParser';

async function archive(files: Record<string, string>): Promise<ArrayBuffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
}

describe('PPTX zip limits', () => {
  it('rejects aggregate expansion and extreme compression before extraction', async () => {
    const bytes = await archive({
      '[Content_Types].xml': 'a'.repeat(32_000),
      'ppt/presentation.xml': 'b'.repeat(32_000),
    });
    await expect(
      parseZip(bytes, { maxTotalUncompressedBytes: 50_000, maxCompressionRatio: 1000 }),
    ).rejects.toThrow(/total uncompressed bytes/i);
    await expect(parseZip(bytes, { maxCompressionRatio: 10 })).rejects.toThrow(
      /compression ?ratio/i,
    );
  });

  it('rejects an excessive entry count', async () => {
    const bytes = await archive({ a: '1', b: '2', c: '3' });
    await expect(parseZip(bytes, { maxEntries: 2 })).rejects.toThrow(/entries 3/i);
  });
});
