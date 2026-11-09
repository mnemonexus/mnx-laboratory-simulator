# Laboratory Simulator (MnemoNexus add-on)

A walkable 3D laboratory for the biosciences and chemistry, built as a MnemoNexus add-on. Prepare samples at the bench, run
plate-reader assays, work titrations and reactions, and visit the centrifuge and chromatography stations. It is an early
preview: some stations are still demonstrations.

The science runs in a headless core (`packages/lab-core`, with Rust/Wasm kernels in `packages/lab-science-rust` and subject packs
such as `pack-chemistry`, `pack-biochemistry`, `pack-microbiology`, `pack-molecular-biology` and `pack-aqueous`). The 3D room, the
UI and the add-on wiring are in `src/`.

## Building

It is built with the [MnemoNexus add-on kit](https://github.com/mnemonexus/mnx-addon-kit), which `package.json` expects as a sibling
folder named `mnx-addon-kit-release`.

```
npm install
npm run addon:pack     # builds dist/*.mnxpack
npm test
```

Then install the `.mnxpack` from **Add-ons → Install from file** in MnemoNexus.

## Third-party data and assets

- `packages/pack-aqueous` includes data derived from the PHREEQC `minteq.v4.dat` database (USGS); see `packages/pack-aqueous/NOTICE-PHREEQC.txt`.
- The textures in `src/assets` were generated for this project.

## Licence

MIT, see [LICENSE](LICENSE).
