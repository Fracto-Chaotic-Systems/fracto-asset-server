# Grass-strip release

Release `d8e227c70918a9be7a1db2ba1f7f759de1ae7d8a9e9cd0d9c79bbf7df326716c`
captures accepted component revision 17: 664 objects, 88 pinned materials and all
173 declared files, including attribution notices. It is a complete approximately
62 MB runtime package. The source description remains in the authoring service.
Resource blobs have short hash-based filenames for Windows Git compatibility;
the manifest retains the original logical paths, including relative textures.

The Play UI now selects optimized release
`bd9af53adc6de4a1be2b1bf8a789ef99fa5bd6399dcedf35b0db1d5a655caf69` in
`GamesPlayGrassRelease.js`. It preserves the exact revision-17 component and all
material calibration pins, applying lossless Meshopt compression to the two grass
GLBs. Sparse grass drops from 27,031,764 to 11,406,728 bytes, dense grass from
18,777,264 to 12,984,784 bytes. The full package drops from 62,396,535 to
40,979,491 bytes (34.3%); the grass downloads alone shrink 46.8%. Every decoded
buffer, including all morph frames, remains byte-identical, as do all PNG images.
`NOTICE.txt` records the derivation and retains source credits. The original
release above is retained for comparison and rollback. The viewer needs the
updated bundled decoder together with this new release.

The side-by-side WebGL comparison at component times 0, 1 and 2 seconds matched
all 13,824 visible morph weights and every framebuffer byte, including shadows.
The UI's HTTP regression additionally decodes every source buffer view of both
grass assets using its actual bundled Three.js decoder and requires byte equality.

The independent motion description is not embedded in the model package. Deploy this
directory with the updated asset service and UI. No component-table restore or
authoring registry synchronization is needed for game playback.
