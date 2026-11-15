'use client';
import { Button } from '@/components/ui/button';
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="fatal-error">
      <div className="brand-mark">D</div>
      <h1>Let’s get you back in flow.</h1>
      <p>We couldn’t load this workspace. Check the database connection and try again.</p>
      <Button onClick={reset}>Try again</Button>
      <a href="/login">Back to sign in</a>
    </main>
  );
}
