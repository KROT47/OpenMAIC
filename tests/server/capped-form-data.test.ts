import { describe, expect, it } from 'vitest';
import { parseCappedFormData, UploadTooLargeError } from '@/lib/server/capped-stream';

async function streamedMultipart(value: string): Promise<{ request: Request; bytes: number }> {
  const form = new FormData();
  form.set('file', new File([value], 'demo.txt', { type: 'text/plain' }));
  const encoded = new Request('http://localhost/upload', { method: 'POST', body: form });
  const bytes = new Uint8Array(await encoded.arrayBuffer());
  const contentType = encoded.headers.get('content-type')!;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 7) {
        controller.enqueue(bytes.slice(offset, offset + 7));
      }
      controller.close();
    },
  });
  return {
    request: new Request('http://localhost/upload', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
      duplex: 'half',
    } as RequestInit),
    bytes: bytes.byteLength,
  };
}

describe('parseCappedFormData', () => {
  it('parses a chunked multipart body below the actual-byte cap', async () => {
    const input = await streamedMultipart('safe');
    const form = await parseCappedFormData(input.request, input.bytes);
    expect(await (form.get('file') as File).text()).toBe('safe');
  });

  it('rejects a chunked body as soon as actual bytes exceed the cap', async () => {
    const input = await streamedMultipart('attacker-controlled-body');
    await expect(parseCappedFormData(input.request, input.bytes - 1)).rejects.toBeInstanceOf(
      UploadTooLargeError,
    );
  });
});
