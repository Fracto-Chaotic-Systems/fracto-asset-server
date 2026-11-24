# Grass-strip release

Release `d8e227c70918a9be7a1db2ba1f7f759de1ae7d8a9e9cd0d9c79bbf7df326716c`
captures accepted component revision 17: 664 objects, 88 pinned materials and all
173 declared files, including attribution notices. It is a complete approximately
62 MB runtime package. The source description remains in the authoring service.
Resource blobs have short hash-based filenames for Windows Git compatibility;
the manifest retains the original logical paths, including relative textures.

The Play UI explicitly selects this release in `GamesPlayGrassRelease.js`. Its
independent motion description is not embedded in the model package. Deploy this
directory with the updated asset service and UI. No component-table restore or
authoring registry synchronization is needed for game playback.
