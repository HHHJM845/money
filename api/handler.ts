import { handle } from '../server/http.js';

export async function GET(request: Request) { return handle(request); }
export async function POST(request: Request) { return handle(request); }
