# Unity Asset Store Downloader

Bulk downloader for Unity Asset Store purchased assets. Authenticates via the kharma API, lists all purchased packages, and downloads `.unitypackage` files.

## Setup

```bash
npm install
```

## Usage

### List purchased assets (dry run)

```bash
npx tsx src/index.ts --dry-run --email you@example.com --password yourpass
```

### Download all assets

```bash
npx tsx src/index.ts --email you@example.com --password yourpass --skip-existing
```

### Download with limit

```bash
npx tsx src/index.ts --limit 5 --skip-existing
```

Sessions are cached for 12 hours — you only need to provide credentials once.

## Options

| Flag | Description |
|------|-------------|
| `--email <email>` | Unity account email |
| `--password <pass>` | Unity account password |
| `--output <dir>` | Output directory (default: `~/AppData/Roaming/Unity/Asset Store-5.x`) |
| `--dry-run` | List assets without downloading |
| `--limit <n>` | Download at most N assets |
| `--skip-existing` | Skip already-downloaded `.unitypackage` files |
| `--concurrency <n>` | Parallel downloads (default: 3) |
| `--supplement <file>` | JSON file with extra asset IDs from browser scraper |

## Handling Missing Assets (138 vs 187)

The kharma legacy API (`/api/en-US/account/downloads.json`) may not return all assets — particularly free assets added to your account. The browser scraper fills this gap.

### Step 1: Scrape full asset list

1. Log in to [assetstore.unity.com](https://assetstore.unity.com)
2. Navigate to **My Assets** (`/account/assets`)
3. Open DevTools Console (F12)
4. Paste the contents of `browser/scrape-assets.js` and run
5. Save the clipboard output to `scraped-assets.json`

### Step 2: Download with supplement

```bash
npx tsx src/index.ts --supplement scraped-assets.json --dry-run
npx tsx src/index.ts --supplement scraped-assets.json --skip-existing
```

The supplement merges extra IDs with the kharma API results (deduped), then attempts to download all of them.

## Output Structure

Files are saved to the Unity Asset Store cache folder:

```
Asset Store-5.x/
  Publisher Name/
    Category/
      Package Name.unitypackage
```

## License

MIT
