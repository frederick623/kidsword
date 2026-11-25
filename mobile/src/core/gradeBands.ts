import content from "../data/content.json";
import type { GradeBandCode, GradeBandSpec } from "./models";

export const GRADE_BANDS = content.grade_bands as Record<GradeBandCode, GradeBandSpec>;
