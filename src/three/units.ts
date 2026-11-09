// Scene coordinates stay unchanged when calibrating displayed world distances.
// This conversion is for spatial measurements, not assay quantities or volumes.
export const CENTIMETRES_PER_SCENE_UNIT = 170 / 1.4

export function centimetresToSceneUnits(centimetres: number): number {
  return centimetres / CENTIMETRES_PER_SCENE_UNIT
}

export function sceneUnitsToCentimetres(units: number): number {
  return units * CENTIMETRES_PER_SCENE_UNIT
}
