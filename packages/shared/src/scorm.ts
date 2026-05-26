import { z } from 'zod';

// SCORM activity config — what's stored on the activities row when
// kind = 'scorm_course'.
export const ScormCourseActivityConfigSchema = z.object({
  scormPackageId: z.string().uuid(),
});
export type ScormCourseActivityConfig = z.infer<
  typeof ScormCourseActivityConfigSchema
>;
