import { promises as fs } from 'fs';
import path from 'path';
import type { NextRequest } from 'next/server';
import type { Scene, Stage } from '@/lib/types/stage';
import type { PPTElement, Slide } from '@openmaic/dsl';
import sanitizeHtml from 'sanitize-html';
import { validateAppScene, validateAppStage } from '@/lib/document-store/validators';

export const CLASSROOMS_DIR = path.join(process.cwd(), 'data', 'classrooms');
export const CLASSROOM_JOBS_DIR = path.join(process.cwd(), 'data', 'classroom-jobs');

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export async function ensureClassroomsDir() {
  await ensureDir(CLASSROOMS_DIR);
}

export async function ensureClassroomJobsDir() {
  await ensureDir(CLASSROOM_JOBS_DIR);
}

export async function writeJsonFileAtomic(filePath: string, data: unknown) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);

  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = JSON.stringify(data, null, 2);
  await fs.writeFile(tempFilePath, content, 'utf-8');
  await fs.rename(tempFilePath, filePath);
}

async function writeJsonFileExclusive(filePath: string, data: unknown) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempFilePath, JSON.stringify(data, null, 2), {
    encoding: 'utf-8',
    flag: 'wx',
  });
  try {
    await fs.link(tempFilePath, filePath);
  } finally {
    await fs.unlink(tempFilePath).catch(() => undefined);
  }
}

export function buildRequestOrigin(req: NextRequest): string {
  return req.headers.get('x-forwarded-host')
    ? `${req.headers.get('x-forwarded-proto') || 'http'}://${req.headers.get('x-forwarded-host')}`
    : req.nextUrl.origin;
}

export interface PersistedClassroomData {
  id: string;
  stage: Stage;
  scenes: Scene[];
  createdAt: string;
}

export function isValidClassroomId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

export class InvalidClassroomError extends Error {
  override readonly name = 'InvalidClassroomError';
}

function classroomFilePath(id: string): string {
  if (!isValidClassroomId(id)) throw new InvalidClassroomError('Invalid classroom id');
  const filePath = path.resolve(CLASSROOMS_DIR, `${id}.json`);
  if (path.dirname(filePath) !== path.resolve(CLASSROOMS_DIR)) {
    throw new InvalidClassroomError('Invalid classroom path');
  }
  return filePath;
}

const SAFE_CSS_VALUE = [/^(?!.*(?:url|expression)\s*\()[^;{}\r\n]*$/i];
const SAFE_STYLE = {
  '*': {
    color: SAFE_CSS_VALUE,
    'background-color': SAFE_CSS_VALUE,
    'font-family': SAFE_CSS_VALUE,
    'font-size': SAFE_CSS_VALUE,
    'font-style': SAFE_CSS_VALUE,
    'font-weight': SAFE_CSS_VALUE,
    'letter-spacing': SAFE_CSS_VALUE,
    'line-height': SAFE_CSS_VALUE,
    'text-align': SAFE_CSS_VALUE,
    'text-decoration': SAFE_CSS_VALUE,
    'vertical-align': SAFE_CSS_VALUE,
    'white-space': SAFE_CSS_VALUE,
  },
};
const RICH_TEXT_TAGS = [
  ...sanitizeHtml.defaults.allowedTags,
  'div',
  'span',
  'u',
  's',
  'sub',
  'sup',
  'mark',
];
const RICH_TEXT_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: RICH_TEXT_TAGS,
  allowedAttributes: { '*': ['style'], a: ['href', 'target', 'rel'] },
  allowedStyles: SAFE_STYLE,
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
};
const KATEX_OPTIONS: sanitizeHtml.IOptions = {
  ...RICH_TEXT_OPTIONS,
  allowedTags: [
    ...RICH_TEXT_TAGS,
    'math',
    'semantics',
    'annotation',
    'mrow',
    'mi',
    'mn',
    'mo',
    'mtext',
    'mspace',
    'msup',
    'msub',
    'msubsup',
    'mfrac',
    'msqrt',
    'mroot',
    'mtable',
    'mtr',
    'mtd',
    'mover',
    'munder',
    'munderover',
  ],
  allowedAttributes: {
    '*': ['class', 'style', 'aria-hidden', 'aria-label'],
    a: ['href', 'target', 'rel'],
    annotation: ['encoding'],
    math: ['xmlns'],
  },
};

function sanitizeSlide(slide: Slide): Slide {
  return {
    ...slide,
    elements: (Array.isArray(slide.elements) ? slide.elements : []).map((element) => {
      const value = element as PPTElement;
      if (value.type === 'text') {
        return { ...value, content: sanitizeHtml(value.content, RICH_TEXT_OPTIONS) };
      }
      if (value.type === 'shape' && value.text) {
        return {
          ...value,
          text: { ...value.text, content: sanitizeHtml(value.text.content, RICH_TEXT_OPTIONS) },
        };
      }
      if (value.type === 'table') {
        return {
          ...value,
          data: value.data.map((row) =>
            row.map((cell) => ({
              ...cell,
              text: sanitizeHtml(cell.text, RICH_TEXT_OPTIONS),
            })),
          ),
        };
      }
      if (value.type === 'latex' && value.html) {
        return { ...value, html: sanitizeHtml(value.html, KATEX_OPTIONS) };
      }
      return value;
    }),
  };
}

export function sanitizeClassroomRichText(data: PersistedClassroomData): PersistedClassroomData {
  return {
    ...data,
    stage: {
      ...data.stage,
      ...(data.stage.whiteboard
        ? { whiteboard: data.stage.whiteboard.map((slide) => sanitizeSlide(slide as Slide)) }
        : {}),
    },
    scenes: data.scenes.map((scene) => ({
      ...scene,
      ...(scene.content.type === 'slide'
        ? { content: { ...scene.content, canvas: sanitizeSlide(scene.content.canvas) } }
        : {}),
      ...(scene.whiteboards
        ? { whiteboards: scene.whiteboards.map((slide) => sanitizeSlide(slide)) }
        : {}),
    })) as Scene[],
  };
}

function prepareClassroom(data: {
  id: string;
  stage: Stage;
  scenes: Scene[];
}): PersistedClassroomData {
  classroomFilePath(data.id);
  if (data.stage.id !== data.id || data.scenes.some((scene) => scene.stageId !== data.id)) {
    throw new InvalidClassroomError('Classroom stage ids must match');
  }
  const stageValidation = validateAppStage(data.stage);
  const sceneValidation = data.scenes.map(validateAppScene).find((result) => !result.valid);
  if (!stageValidation.valid || sceneValidation) {
    throw new InvalidClassroomError('Classroom data does not match the document contract');
  }
  return sanitizeClassroomRichText({ ...data, createdAt: new Date().toISOString() });
}

export async function readClassroom(id: string): Promise<PersistedClassroomData | null> {
  const filePath = classroomFilePath(id);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return sanitizeClassroomRichText(JSON.parse(content) as PersistedClassroomData);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function persistClassroom(
  data: {
    id: string;
    stage: Stage;
    scenes: Scene[];
  },
  baseUrl: string,
): Promise<PersistedClassroomData & { url: string }> {
  const classroomData = prepareClassroom(data);

  await ensureClassroomsDir();
  const filePath = classroomFilePath(data.id);
  await writeJsonFileAtomic(filePath, classroomData);

  return {
    ...classroomData,
    url: `${baseUrl}/classroom/${data.id}`,
  };
}

/** Public ingestion is create-only; trusted generation uses persistClassroom for retries. */
export async function createClassroom(
  data: { id: string; stage: Stage; scenes: Scene[] },
  baseUrl: string,
): Promise<PersistedClassroomData & { url: string }> {
  const classroomData = prepareClassroom(data);
  await writeJsonFileExclusive(classroomFilePath(data.id), classroomData);
  return { ...classroomData, url: `${baseUrl}/classroom/${data.id}` };
}
