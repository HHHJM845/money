import { handle } from '../server/http';

export async function GET(request: Request) { return handle(request); }
export async function POST(request: Request) { return handle(request); }
