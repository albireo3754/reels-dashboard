import { requireChatGPTUser } from './chatgpt-auth';
import { Briefing } from './briefing';
export const dynamic='force-dynamic';
export default async function Page(){await requireChatGPTUser('/');return <Briefing/>;}
