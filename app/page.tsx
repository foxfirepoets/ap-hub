import { redirect } from 'next/navigation';

// The app root lands on Today; the (app) shell then guards the session (→ /login if anon).
export default function HomePage() {
  redirect('/today');
}
