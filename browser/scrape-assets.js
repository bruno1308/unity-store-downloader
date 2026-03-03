/**
 * Unity Asset Store — Full Asset List Scraper
 *
 * Paste in Chrome DevTools Console while logged into assetstore.unity.com/account/assets.
 * Paginates through ALL pages (25 per page) and extracts every package ID + name.
 *
 * Output: JSON array of { id, name } copied to clipboard.
 * Save to a file and pass to the downloader with --supplement <file>.
 */
(async () => {
  console.log("=== Unity Asset Store — Full Asset Scraper ===\n");

  const PER_PAGE = 25;
  const allAssets = new Map(); // id -> name (dedup)

  // Scrape current page's assets from the DOM
  function scrapeCurrentPage() {
    const items = [];
    // Asset links follow the pattern /packages/slug-{id}
    document.querySelectorAll('a[href*="/packages/"]').forEach((a) => {
      const href = a.getAttribute("href") || "";
      // Extract numeric ID from the end of the slug: /packages/some-name-123456 -> 123456
      const match = href.match(/\/packages\/[^/]+-(\d+)$/);
      if (!match) return;
      const id = match[1];
      // Get the display name — look for the closest text content
      const name = a.textContent?.trim() || `Package ${id}`;
      if (id && !allAssets.has(id)) {
        items.push({ id, name: name.slice(0, 200) });
      }
    });
    return items;
  }

  // Scrape the first page
  const firstPage = scrapeCurrentPage();
  for (const a of firstPage) allAssets.set(a.id, a.name);
  console.log(`Page 1: found ${firstPage.length} assets (total: ${allAssets.size})`);

  // Find the pagination buttons to determine total pages
  const pageButtons = document.querySelectorAll('[class*="pagination"] button, [class*="pagination"] a, nav button, nav a');
  let totalPages = 1;

  // Try to find max page number from pagination
  pageButtons.forEach((btn) => {
    const text = btn.textContent?.trim();
    const num = parseInt(text || "", 10);
    if (!isNaN(num) && num > totalPages) totalPages = num;
  });

  // If no pagination found, estimate from total count
  if (totalPages === 1) {
    // Look for "X Assets" text on the page
    const countText = document.body.innerText.match(/(\d+)\s+Assets?/i);
    if (countText) {
      const total = parseInt(countText[1], 10);
      totalPages = Math.ceil(total / PER_PAGE);
      console.log(`Detected ${total} total assets across ${totalPages} pages`);
    }
  }

  if (totalPages <= 1) {
    console.log("Only 1 page detected. If you have more assets, scroll down or navigate manually.");
  }

  // Click through remaining pages
  for (let page = 2; page <= totalPages; page++) {
    console.log(`Navigating to page ${page}/${totalPages}...`);

    // Find and click the "next" button or the specific page number
    let clicked = false;

    // Try clicking the page number directly
    for (const btn of pageButtons) {
      if (btn.textContent?.trim() === String(page)) {
        btn.click();
        clicked = true;
        break;
      }
    }

    // Or try clicking "Next" / ">" button
    if (!clicked) {
      for (const btn of document.querySelectorAll('button, a')) {
        const text = btn.textContent?.trim().toLowerCase();
        const label = btn.getAttribute("aria-label")?.toLowerCase() || "";
        if (text === "next" || text === ">" || label.includes("next")) {
          btn.click();
          clicked = true;
          break;
        }
      }
    }

    if (!clicked) {
      // Try URL manipulation as fallback
      const url = new URL(window.location.href);
      url.searchParams.set("page", String(page));
      window.location.href = url.toString();
      // Wait for full page load
      await new Promise((r) => setTimeout(r, 3000));
    } else {
      // Wait for content to update (SPA-style)
      await new Promise((r) => setTimeout(r, 2000));
    }

    const pageItems = scrapeCurrentPage();
    for (const a of pageItems) allAssets.set(a.id, a.name);
    console.log(`Page ${page}: found ${pageItems.length} new assets (total: ${allAssets.size})`);
  }

  // Build output
  const result = Array.from(allAssets.entries()).map(([id, name]) => ({ id, name }));

  console.log(`\n=== Results ===`);
  console.log(`Total unique assets: ${result.length}`);
  console.log(`\nFirst 5:`);
  result.slice(0, 5).forEach((a) => console.log(`  ${a.id}: ${a.name}`));

  const json = JSON.stringify(result, null, 2);

  try {
    await navigator.clipboard.writeText(json);
    console.log(`\nCopied ${result.length} assets to clipboard!`);
  } catch {
    console.log("\nCouldn't copy to clipboard — select and copy from below:");
  }

  console.log("\nSave to a .json file and use with:");
  console.log("  npx tsx src/index.ts --supplement scraped-assets.json --dry-run");
  console.log("\nJSON output:");
  console.log(json);
})();
