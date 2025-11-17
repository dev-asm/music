# Local Samples Directory

This directory is where you can place your own audio sample files (`.wav`, `.mp3`, `.ogg`, `.flac`, `.aiff`, `.aif`, `.m4a`) to use in your Strudel patterns.

## Quick Start

1. **Add your sample files** to this directory (or create subdirectories to organize them):
   ```
   public/samples/
   ├── kick.wav
   ├── snare.wav
   └── piano/
       ├── c4.wav
       ├── d4.wav
       └── e4.wav
   ```

2. **Generate the sample map** by running:
   ```bash
   npm run generate:samples
   ```
   
   This scans `public/samples/` and creates `public/sample-banks/local.json` automatically.

3. **Restart your dev server** (if running) to pick up the new samples.

4. **Use your samples** in Strudel patterns:
   ```js
   note("c4 e4 g4").sound("piano")
   s("kick snare kick snare")
   ```

## How It Works

- Files are organized by **subdirectory name** → sample category
  - `public/samples/piano/*.wav` → `sound("piano")`
  - `public/samples/drums/kick.wav` → `sound("drums")` (uses first file)
  - Files in the root → `sound("root")`

- The script automatically:
  - Scans all audio files recursively
  - Groups them by directory
  - Generates a JSON map that Strudel can load
  - Serves files from `/samples/` (relative to your domain)

## Examples

### Single files
```
public/samples/
└── mykick.wav
```
→ Use as: `sound("root")` (will play `mykick.wav`)

### Organized by category
```
public/samples/
├── drums/
│   ├── kick.wav
│   └── snare.wav
└── piano/
    ├── c4.wav
    └── d4.wav
```
→ Use as: `sound("drums")` or `sound("piano")`

### Multiple samples per category
If you have multiple files in a category, Strudel will cycle through them based on the note number:
```js
note("c4 d4 e4").sound("piano")  // Cycles through piano/*.wav files
```

## Regenerating the Map

Run `npm run generate:samples` whenever you:
- Add new sample files
- Remove sample files
- Reorganize directories

The script is also automatically run during `npm run build`, so your samples will always be up-to-date in production builds.

## Notes

- Sample files are served statically from `/samples/` (via Next.js `public/` directory)
- File names don't matter for the sample key - only the directory structure
- The generated `local.json` is automatically loaded when the Strudel engine starts
- If `local.json` is empty (no samples found), it won't cause errors

