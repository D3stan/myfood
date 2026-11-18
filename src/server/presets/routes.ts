import type { Hono } from 'hono';
import { PresetBody } from '../../shared/types.ts';
import type { AppEnv, RouteDeps } from '../route-kit.ts';
import { createPreset, deletePreset, patchPreset } from './repo.ts';

export function registerPresetRoutes(
  app: Hono<AppEnv>,
  { db, state, json, parse, id }: RouteDeps,
): void {
  app.post('/api/presets', async c => {
    createPreset(db, c.get('uid'), parse(PresetBody, await json(c)));
    return c.json(state(c.get('uid')));
  });
  app.patch('/api/presets/:id', async c => {
    patchPreset(db, c.get('uid'), id(c), parse(PresetBody, await json(c)));
    return c.json(state(c.get('uid')));
  });
  app.delete('/api/presets/:id', c => {
    deletePreset(db, c.get('uid'), id(c));
    return c.json(state(c.get('uid')));
  });
}
