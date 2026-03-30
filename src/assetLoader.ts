/**
 * Asset Loader - Loads furniture assets from per-folder manifests
 *
 * Scans assets/furniture/ subdirectories, reads each manifest.json,
 * and loads all PNG files into SpriteData format for use in the webview.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { CHAR_COUNT, CHAR_FRAMES_PER_ROW, WALL_BITMASK_COUNT } from '../shared/assets/constants.js';
import type {
  FurnitureAsset,
  FurnitureManifest,
  InheritedProps,
  ManifestGroup,
} from '../shared/assets/manifestUtils.js';
import { flattenManifest } from '../shared/assets/manifestUtils.js';
import {
  decodeCharacterPng,
  decodeFloorPng,
  parseWallPng,
  pngToSpriteData,
} from '../shared/assets/pngDecoder.js';
import type { CharacterDirectionSprites } from '../shared/assets/types.js';
export type { CharacterDirectionSprites } from '../shared/assets/types.js';

import { LAYOUT_REVISION_KEY } from './constants.js';

export type { FurnitureAsset };

export interface LoadedAssets {
  catalog: FurnitureAsset[];
  sprites: Map<string, string[][]>; // assetId -> SpriteData
}

export function mergeLoadedAssets(a: LoadedAssets, b: LoadedAssets): LoadedAssets {
  const bIds = new Set(b.catalog.map((item) => item.id));
  const dedupedA = a.catalog.filter((item) => !bIds.has(item.id));
  return {
    catalog: [...dedupedA, ...b.catalog],
    sprites: new Map([...a.sprites, ...b.sprites]),
  };
}

/**
 * Load furniture assets from per-folder manifests
 */
export async function loadFurnitureAssets(roots: string | string[]): Promise<LoadedAssets | null> {
  const workspaceRoots = Array.isArray(roots) ? roots : [roots];
  const catalog: FurnitureAsset[] = [];
  const sprites = new Map<string, string[][]>();

  for (const workspaceRoot of workspaceRoots) {
    try {
      console.log(`[AssetLoader] workspaceRoot received: "${workspaceRoot}"`);
      const furnitureDir = path.join(workspaceRoot, 'assets', 'furniture');
      
      try {
        await fs.promises.access(furnitureDir);
      } catch {
        console.log('ℹ️  No furniture directory found at:', furnitureDir);
        continue;
      }

      console.log(`[AssetLoader] Scanning furniture directory: ${furnitureDir}`);
      const entries = await fs.promises.readdir(furnitureDir, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory());

      if (dirs.length === 0) {
        console.log('ℹ️  No furniture subdirectories found in:', furnitureDir);
        continue;
      }

      console.log(`📦 Found ${dirs.length} furniture folders in ${workspaceRoot}`);

      for (const dir of dirs) {
        const itemDir = path.join(furnitureDir, dir.name);
        const manifestPath = path.join(itemDir, 'manifest.json');

        try {
          await fs.promises.access(manifestPath);
        } catch {
          console.warn(`  ⚠️  No manifest.json in ${dir.name}`);
          continue;
        }

        try {
          const manifestContent = await fs.promises.readFile(manifestPath, 'utf-8');
          const manifest = JSON.parse(manifestContent) as FurnitureManifest;

          // Build the inherited props from the root manifest
          const inherited: InheritedProps = {
            groupId: manifest.id,
            name: manifest.name,
            category: manifest.category,
            canPlaceOnWalls: manifest.canPlaceOnWalls,
            canPlaceOnSurfaces: manifest.canPlaceOnSurfaces,
            backgroundTiles: manifest.backgroundTiles,
          };

          let assets: FurnitureAsset[];

          if (manifest.type === 'asset') {
            // Single asset manifest (no groups) — file defaults to {id}.png
            assets = [
              {
                id: manifest.id,
                name: manifest.name,
                label: manifest.name,
                category: manifest.category,
                file: manifest.file ?? `${manifest.id}.png`,
                width: manifest.width!,
                height: manifest.height!,
                footprintW: manifest.footprintW!,
                footprintH: manifest.footprintH!,
                isDesk: manifest.category === 'desks',
                canPlaceOnWalls: manifest.canPlaceOnWalls,
                canPlaceOnSurfaces: manifest.canPlaceOnSurfaces,
                backgroundTiles: manifest.backgroundTiles,
                groupId: manifest.id,
              },
            ];
          } else {
            // Group manifest — flatten recursively
            if (manifest.rotationScheme) {
              inherited.rotationScheme = manifest.rotationScheme;
            }
            const rootGroup: ManifestGroup = {
              type: 'group',
              groupType: manifest.groupType as 'rotation' | 'state' | 'animation',
              rotationScheme: manifest.rotationScheme,
              members: manifest.members!,
            };
            assets = flattenManifest(rootGroup, inherited);
          }

          // Load PNGs for each asset
          for (const asset of assets) {
            try {
              const assetPath = path.join(itemDir, asset.file);
              try {
                await fs.promises.access(assetPath);
              } catch {
                console.warn(`  ⚠️  Asset file not found: ${asset.file} in ${dir.name}`);
                continue;
              }

              const pngBuffer = await fs.promises.readFile(assetPath);
              const spriteData = pngToSpriteData(pngBuffer, asset.width, asset.height);
              sprites.set(asset.id, spriteData);
            } catch (err) {
              console.warn(
                `  ⚠️  Error loading ${asset.id}: ${err instanceof Error ? err.message : err}`,
              );
            }
          }

          catalog.push(...assets);
        } catch (err) {
          console.warn(
            `  ⚠️  Error processing ${dir.name}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    } catch (err) {
      console.error(
        `[AssetLoader] ❌ Error loading from ${workspaceRoot}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  if (catalog.length === 0) return null;

  console.log(`[AssetLoader] ✅ Successfully loaded ${sprites.size} furniture sprites from ${workspaceRoots.length} roots`);
  return { catalog, sprites };
}

// ── Default layout loading ───────────────────────────────────

/**
 * Load the bundled default layout with the highest revision.
 */
export async function loadDefaultLayout(assetsRoot: string): Promise<Record<string, unknown> | null> {
  const assetsDir = path.join(assetsRoot, 'assets');
  try {
    let bestRevision = 0;
    let bestPath: string | null = null;

    try {
      await fs.promises.access(assetsDir);
      const files = await fs.promises.readdir(assetsDir);
      for (const file of files) {
        const match = /^default-layout-(\d+)\.json$/.exec(file);
        if (match) {
          const rev = parseInt(match[1], 10);
          if (rev > bestRevision) {
            bestRevision = rev;
            bestPath = path.join(assetsDir, file);
          }
        }
      }
    } catch { /* assets dir doesn't exist */ }

    if (!bestPath) {
      const fallback = path.join(assetsDir, 'default-layout.json');
      try {
        await fs.promises.access(fallback);
        bestPath = fallback;
      } catch { /* no fallback */ }
    }

    if (!bestPath) return null;

    const content = await fs.promises.readFile(bestPath, 'utf-8');
    const layout = JSON.parse(content) as Record<string, unknown>;
    if (bestRevision > 0 && !layout[LAYOUT_REVISION_KEY]) {
      layout[LAYOUT_REVISION_KEY] = bestRevision;
    }
    return layout;
  } catch (err) {
    console.error(`[AssetLoader] Error loading default layout: ${err}`);
    return null;
  }
}

// ── Wall tile loading ────────────────────────────────────────

export interface LoadedWallTiles {
  sets: string[][][][];
}

export async function loadWallTiles(assetsRoot: string): Promise<LoadedWallTiles | null> {
  try {
    const wallsDir = path.join(assetsRoot, 'assets', 'walls');
    try {
      await fs.promises.access(wallsDir);
    } catch {
      return null;
    }

    const entries = await fs.promises.readdir(wallsDir);
    const wallFiles: { index: number; filename: string }[] = [];
    for (const entry of entries) {
      const match = /^wall_(\d+)\.png$/i.exec(entry);
      if (match) {
        wallFiles.push({ index: parseInt(match[1], 10), filename: entry });
      }
    }

    if (wallFiles.length === 0) return null;
    wallFiles.sort((a, b) => a.index - b.index);

    const sets: string[][][][] = [];
    for (const { filename } of wallFiles) {
      const filePath = path.join(wallsDir, filename);
      const pngBuffer = await fs.promises.readFile(filePath);
      const sprites = parseWallPng(pngBuffer);
      sets.push(sprites);
    }

    return { sets };
  } catch (err) {
    console.error(`[AssetLoader] Error loading wall tiles: ${err}`);
    return null;
  }
}

/**
 * Send wall tiles to webview
 */
export function sendWallTilesToWebview(webview: vscode.Webview, wallTiles: LoadedWallTiles): void {
  webview.postMessage({
    type: 'wallTilesLoaded',
    sets: wallTiles.sets,
  });
}

export interface LoadedFloorTiles {
  sprites: string[][][]; 
}

export async function loadFloorTiles(assetsRoot: string): Promise<LoadedFloorTiles | null> {
  try {
    const floorsDir = path.join(assetsRoot, 'assets', 'floors');
    try {
      await fs.promises.access(floorsDir);
    } catch {
      return null;
    }

    const entries = await fs.promises.readdir(floorsDir);
    const floorFiles: { index: number; filename: string }[] = [];
    for (const entry of entries) {
      const match = /^floor_(\d+)\.png$/i.exec(entry);
      if (match) {
        floorFiles.push({ index: parseInt(match[1], 10), filename: entry });
      }
    }

    if (floorFiles.length === 0) return null;
    floorFiles.sort((a, b) => a.index - b.index);

    const sprites: string[][][] = [];
    for (const { filename } of floorFiles) {
      const filePath = path.join(floorsDir, filename);
      const pngBuffer = await fs.promises.readFile(filePath);
      const sprite = decodeFloorPng(pngBuffer);
      sprites.push(sprite);
    }

    return { sprites };
  } catch (err) {
    console.error(`[AssetLoader] Error loading floor tiles: ${err}`);
    return null;
  }
}

/**
 * Send floor tiles to webview
 */
export function sendFloorTilesToWebview(
  webview: vscode.Webview,
  floorTiles: LoadedFloorTiles,
): void {
  webview.postMessage({
    type: 'floorTilesLoaded',
    sprites: floorTiles.sprites,
  });
}

// ── Character sprite loading ────────────────────────────────

export interface LoadedCharacterSprites {
  characters: CharacterDirectionSprites[];
}

export async function loadCharacterSprites(
  assetsRoot: string,
): Promise<LoadedCharacterSprites | null> {
  try {
    const charDir = path.join(assetsRoot, 'assets', 'characters');
    const characters: CharacterDirectionSprites[] = [];

    for (let ci = 0; ci < CHAR_COUNT; ci++) {
      const filePath = path.join(charDir, `char_${ci}.png`);
      try {
        await fs.promises.access(filePath);
      } catch {
        return null;
      }
      const pngBuffer = await fs.promises.readFile(filePath);
      characters.push(decodeCharacterPng(pngBuffer));
    }

    return { characters };
  } catch (err) {
    console.error(`[AssetLoader] Error loading character sprites: ${err}`);
    return null;
  }
}

/**
 * Send character sprites to webview
 */
export function sendCharacterSpritesToWebview(
  webview: vscode.Webview,
  charSprites: LoadedCharacterSprites,
): void {
  webview.postMessage({
    type: 'characterSpritesLoaded',
    characters: charSprites.characters,
  });
}

/**
 * Send loaded assets to webview
 */
export function sendAssetsToWebview(webview: vscode.Webview, assets: LoadedAssets): void {
  if (!assets) return;
  const spritesObj: Record<string, string[][]> = {};
  for (const [id, spriteData] of assets.sprites) {
    spritesObj[id] = spriteData;
  }
  webview.postMessage({
    type: 'furnitureAssetsLoaded',
    catalog: assets.catalog,
    sprites: spritesObj,
  });
}
