import { z } from 'zod'

export const featureReferenceSchema = z.object({
  id: z.string(), title: z.string(), purpose: z.string(), ui: z.string(),
  prerequisites: z.string(), workflow: z.array(z.string()), outcome: z.string(),
  cautions: z.string(), commandIds: z.array(z.string()),
})
export type FeatureReference = z.infer<typeof featureReferenceSchema>
