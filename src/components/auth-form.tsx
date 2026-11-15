'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowRight, Command, GitBranch, Loader2, Sparkles } from 'lucide-react';
import { api, body } from '@/lib/client';
import { registerSchema, loginSchema } from '@/lib/validation';
import { Button } from './ui/button';
type Values = z.infer<typeof loginSchema> & { name?: string };
export function AuthForm() {
  const [register, setRegister] = useState(false);
  const [error, setError] = useState('');
  const {
    register: field,
    handleSubmit,
    formState: { errors, isSubmitting },
    clearErrors,
  } = useForm<Values>({ resolver: zodResolver(register ? registerSchema : loginSchema) });
  return (
    <main className="auth-layout">
      <section className="auth-story">
        <Link className="brand" href="/">
          <span className="brand-mark">
            <Command size={20} />
          </span>
          devflow<span className="brand-dot">®</span>
        </Link>
        <div className="auth-copy">
          <span className="eyebrow">
            <span className="live-dot" /> A WORKSPACE THAT GETS YOU
          </span>
          <h1>
            Great work.
            <br />
            Less friction.
            <br />
            <em>More flow.</em>
          </h1>
          <p>
            Bring your projects, people, and ideas together.
            <br />
            Make room for the work that matters.
          </p>
          <div className="auth-mini-board">
            <div>
              <CircleLabel label="In progress" />
              <div className="mini-card">
                <span className="tag">Platform</span>Build something remarkable
                <small>
                  DEV–024 <GitBranch size={13} />
                </small>
              </div>
            </div>
            <div>
              <CircleLabel label="Done" />
              <div className="mini-card mini-done">
                <Sparkles size={16} /> Find your flow
                <small>
                  DEV–001 <span>✓</span>
                </small>
              </div>
            </div>
          </div>
        </div>
        <span className="auth-footer">Thoughtfully built for teams that build.</span>
      </section>
      <section className="auth-form-panel">
        <div className="auth-form-wrap">
          <span className="eyebrow">YOUR NEXT CHAPTER STARTS HERE</span>
          <h2>{register ? 'Make space for great work.' : 'Welcome back.'}</h2>
          <p>
            {register
              ? 'Create your account and start your workspace.'
              : 'Pick up right where you left off.'}
          </p>
          <form
            onSubmit={handleSubmit(async (values) => {
              setError('');
              try {
                await api(`auth/${register ? 'register' : 'login'}`, {
                  method: 'POST',
                  body: body(values),
                });
                window.location.assign('/' + window.location.search);
              } catch (e) {
                setError((e as Error).message);
              }
            })}
          >
            {register && (
              <label>
                Full name
                <input autoComplete="name" placeholder="Alex Morgan" {...field('name')} />
                {errors.name && <span className="field-error">{errors.name.message}</span>}
              </label>
            )}
            <label>
              Email address
              <input
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                {...field('email')}
              />
              {errors.email && <span className="field-error">{errors.email.message}</span>}
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete={register ? 'new-password' : 'current-password'}
                placeholder={register ? 'At least 12 characters' : 'Your password'}
                {...field('password')}
              />
              {errors.password && <span className="field-error">{errors.password.message}</span>}
            </label>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <Loader2 className="spin" size={16} />
              ) : register ? (
                'Create account'
              ) : (
                'Sign in to your workspace'
              )}
              {!isSubmitting && <ArrowRight size={16} />}
            </Button>
          </form>
          <p className="auth-switch">
            {register ? 'Already have an account?' : 'New to DevFlow?'}{' '}
            <button
              onClick={() => {
                setRegister(!register);
                setError('');
                clearErrors();
              }}
            >
              {register ? 'Sign in' : 'Create an account'}
            </button>
          </p>
          <div className="auth-note">
            <span className="live-dot" /> Secure sessions. Your work stays yours.
          </div>
        </div>
      </section>
    </main>
  );
}
function CircleLabel({ label }: { label: string }) {
  return (
    <span className="mini-label">
      <span />
      {label}
    </span>
  );
}
