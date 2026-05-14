// lib/cc360.js — Push a course draft to CC360 via the official public import API
import axios from 'axios';
import { renderLessonHTML, buildTheme } from './render-html.js';

/**
 * Build the import payload, optionally embedding lesson workbook download links
 * and lesson thumbnail images.
 *
 * @param {Object} opts
 * @param {string} opts.locationId
 * @param {Object} opts.draft       - structure with modules[].lessons[]
 * @param {string} opts.accent
 * @param {Object<string,string>} [opts.workbookUrlByLessonKey] - map of "m{i}-l{j}" -> public PDF URL
 * @param {Object<string,string>} [opts.thumbnailUrlByLessonKey] - map of "m{i}-l{j}" -> public image URL
 */
export function buildImportPayload({ locationId, draft, accent, workbookUrlByLessonKey = {}, thumbnailUrlByLessonKey = {} }) {
  const theme = buildTheme(accent);
  return {
    locationId,
    products: [
      {
        title: draft.courseTitle,
        description: draft.courseDescription || `Course built on ${new Date().toLocaleDateString()}`,
        categories: (draft.modules || []).map((mod, mi) => ({
          title: mod.title,
          description: mod.description || '',
          posts: (mod.lessons || []).map((lesson, li) => {
            const key = `m${mi}-l${li}`;
            const workbookUrl = workbookUrlByLessonKey[key];
            const thumbnailUrl = thumbnailUrlByLessonKey[key];
            return {
              title: lesson.title,
              description: renderLessonHTML(lesson, theme, { workbookUrl, thumbnailUrl }),
              contentType: 'video',
            };
          }),
        })),
      },
    ],
  };
}

export async function importCourse({ pit, locationId, draft, accent, workbookUrlByLessonKey, thumbnailUrlByLessonKey }) {
  const payload = buildImportPayload({ locationId, draft, accent, workbookUrlByLessonKey, thumbnailUrlByLessonKey });
  const res = await axios.post(
    'https://services.leadconnectorhq.com/courses/courses-exporter/public/import',
    payload,
    {
      headers: {
        'accept': 'application/json',
        'authorization': `Bearer ${pit}`,
        'content-type': 'application/json',
        'version': '2021-07-28',
      },
      timeout: 120000,
    }
  );
  const course = res.data.processingCourses?.[0];
  if (!course) throw new Error(`Unexpected response: ${JSON.stringify(res.data)}`);
  return { ...course, message: res.data.message, note: res.data.note };
}