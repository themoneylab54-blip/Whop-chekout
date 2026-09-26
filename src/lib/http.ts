import { NextResponse } from "next/server";

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

export function json(data: unknown, init: { status?: number; cors?: boolean; headers?: Record<string, string> } = {}) {
  return NextResponse.json(data, {
    status: init.status ?? 200,
    headers: { ...(init.cors ? CORS_HEADERS : {}), ...init.headers },
  });
}

export function preflight() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
