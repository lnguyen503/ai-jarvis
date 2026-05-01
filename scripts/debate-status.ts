// @ts-ignore — node:sqlite is builtin in Node 22+
import { DatabaseSync } from 'node:sqlite';

async function main() {
  const db: any = new DatabaseSync('D:/ai-jarvis/data/ai-jarvis/jarvis.db', { readOnly: true });
  const memory: any = { db };

  console.log('=== group_settings (debate flag) ===');
  const gs = (memory.db as any).prepare('SELECT chat_id, avengers_assemble, avengers_debate FROM group_settings').all();
  console.log(JSON.stringify(gs, null, 2));

  console.log('\n=== recent plans ===');
  const plans = (memory.db as any).prepare('SELECT id, chat_id, status, datetime(created_at) as created, deliverable_message_id FROM plans ORDER BY id DESC LIMIT 8').all();
  console.log(JSON.stringify(plans, null, 2));

  console.log('\n=== recent plan_steps with debate cols ===');
  const steps = (memory.db as any).prepare('SELECT plan_id, id, bot_name, status, debate_status, debate_rounds FROM plan_steps WHERE plan_id IN (SELECT id FROM plans ORDER BY id DESC LIMIT 5) ORDER BY plan_id DESC, id ASC').all();
  console.log(JSON.stringify(steps, null, 2));

  console.log('\n=== debate rounds (most recent 40) ===');
  const rounds = (memory.db as any).prepare('SELECT step_id, round, speaker, model, verdict, length(text) as text_len, substr(text, 1, 180) as text_head, datetime(created_at) as created FROM plan_step_debates ORDER BY id DESC LIMIT 40').all();
  console.log(JSON.stringify(rounds, null, 2));

  console.log('\n=== summary ===');
  const counts = (memory.db as any).prepare("SELECT debate_status, COUNT(*) as n FROM plan_steps WHERE debate_status IS NOT NULL GROUP BY debate_status").all();
  console.log('outcomes by debate_status:', JSON.stringify(counts));
  const totalRounds = (memory.db as any).prepare('SELECT COUNT(*) as n FROM plan_step_debates').get();
  console.log('total debate rounds in db:', JSON.stringify(totalRounds));

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
