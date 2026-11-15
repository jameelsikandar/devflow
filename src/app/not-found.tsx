import Link from 'next/link';
export default function NotFound() {
  return (
    <main className="fatal-error">
      <span className="eyebrow">404 · OFF THE BEATEN PATH</span>
      <h1>Nothing here. Plenty ahead.</h1>
      <p>This page doesn’t exist, or has moved.</p>
      <Link className="button button-primary" href="/">
        Back to workspace
      </Link>
    </main>
  );
}
