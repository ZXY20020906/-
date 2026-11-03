/**
 * Cloudflare Pages Functions：/api/* 全部交给 src/server/app.js。
 * 这个文件保持极薄，方便你以后换框架时只改这一层。
 */
import { handle } from '../../src/server/app.js';

export async function onRequest(context) {
  return handle(context.request, context.env, context);
}
