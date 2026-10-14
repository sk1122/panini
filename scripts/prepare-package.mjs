#!/usr/bin/env node
import { copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
await mkdir(resolve(root, 'package-assets'), { recursive: true });
await copyFile(resolve(root, 'pnpm-lock.yaml'), resolve(root, 'package-assets', 'pnpm-lock.yaml'));
