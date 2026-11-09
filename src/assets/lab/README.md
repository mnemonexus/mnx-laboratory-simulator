# Furniture surface assets

`walnut-veneer-atlas-v1.jpg` is an original AI-generated walnut veneer atlas created on 2026-10-25 for the user's door realism request. The supplied door photograph informed the wood colour and grain direction; the photograph is not shipped or used as a texture. The atlas contains eight veneer cuts in four columns and two rows. It was generated with the image-generation tool, then encoded as a quality-93 JPEG (343,144 bytes).

`src/three/lab/furnitureFinishes.ts` loads this single bundled asset into a shared texture for each quality tier: 512 pixels square on Low, 1024 on Medium, and 2048 on High/Ultra. Stable door IDs select a cut and a small crop variation. All slabs around a door's vision panel use continuous leaf-space UVs. No per-door image download or material is needed. The brushed-metal roughness, vinyl normal and expanded-metal alpha patterns are generated locally and shared.
