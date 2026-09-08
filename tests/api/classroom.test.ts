import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { PersistedClassroomData } from '@/lib/server/classroom-storage';

const mocks = vi.hoisted(() => ({ createClassroom: vi.fn() }));

vi.mock('crypto', async () => ({
  ...(await vi.importActual<typeof import('crypto')>('crypto')),
  randomUUID: () => '11111111-1111-4111-8111-111111111111',
}));
vi.mock('@/lib/server/classroom-storage', async () => ({
  ...(await vi.importActual<typeof import('@/lib/server/classroom-storage')>(
    '@/lib/server/classroom-storage',
  )),
  createClassroom: mocks.createClassroom,
}));

import { POST } from '@/app/api/classroom/route';
import { sanitizeClassroomRichText } from '@/lib/server/classroom-storage';
import { persistClassroom } from '@/lib/server/classroom-storage';

beforeEach(() => {
  mocks.createClassroom.mockReset();
  mocks.createClassroom.mockImplementation(async (data) => ({
    ...data,
    createdAt: new Date(0).toISOString(),
    url: `http://localhost/classroom/${data.id}`,
  }));
});

describe('POST /api/classroom', () => {
  it('ignores the caller id and creates a consistent server-owned identifier', async () => {
    const response = await POST(
      new NextRequest('http://localhost/api/classroom', {
        method: 'POST',
        body: JSON.stringify({
          stage: { id: '../../package', name: 'Lesson', createdAt: 1, updatedAt: 1 },
          scenes: [
            {
              id: 'scene-1',
              stageId: '../../package',
              title: 'Slide',
              order: 1,
              type: 'slide',
              content: { type: 'slide', canvas: { elements: [] } },
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.createClassroom).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '11111111-1111-4111-8111-111111111111',
        stage: expect.objectContaining({ id: '11111111-1111-4111-8111-111111111111' }),
        scenes: [expect.objectContaining({ stageId: '11111111-1111-4111-8111-111111111111' })],
      }),
      'http://localhost',
    );
  });
});

describe('classroom rich-text boundary', () => {
  it('rejects traversal identifiers before touching the filesystem', async () => {
    await expect(
      persistClassroom(
        {
          id: '../../package',
          stage: { id: '../../package', name: 'Lesson', createdAt: 1, updatedAt: 1 },
          scenes: [],
        },
        'http://localhost',
      ),
    ).rejects.toThrow('Invalid classroom id');
  });

  it('strips executable markup on legacy reads while preserving formatting and KaTeX', () => {
    const data = {
      id: 'lesson',
      createdAt: new Date(0).toISOString(),
      stage: { id: 'lesson', name: 'Lesson', createdAt: 1, updatedAt: 1 },
      scenes: [
        {
          id: 'scene-1',
          stageId: 'lesson',
          title: 'Slide',
          order: 1,
          type: 'slide',
          content: {
            type: 'slide',
            canvas: {
              elements: [
                {
                  id: 'text',
                  type: 'text',
                  content:
                    '<p style="font-size: 20px" onclick="steal()"><strong>Safe</strong><img src=x onerror=steal()><script>steal()</script></p>',
                },
                {
                  id: 'latex',
                  type: 'latex',
                  latex: 'x',
                  html: '<span class="katex"><math><semantics><mrow><mi>x</mi></mrow></semantics></math></span><img onerror=steal()>',
                },
              ],
            },
          },
        },
      ],
    } as unknown as PersistedClassroomData;

    const cleaned = sanitizeClassroomRichText(data);
    const elements = (cleaned.scenes[0]!.content as { canvas: { elements: unknown[] } }).canvas
      .elements as Array<{ content?: string; html?: string }>;
    expect(elements[0]!.content).toContain('<strong>Safe</strong>');
    expect(elements[0]!.content).toContain('font-size:20px');
    expect(elements[0]!.content).not.toMatch(/script|onerror|onclick|<img/i);
    expect(elements[1]!.html).toContain('class="katex"');
    expect(elements[1]!.html).toContain('<math>');
    expect(elements[1]!.html).not.toMatch(/onerror|<img/i);
  });
});
