'use client'

import { FormEvent, useState } from 'react'
import { useRouter } from 'next/navigation'
import { signIn, signUp } from '@/lib/auth-client'

export default function SignInPage() {
  const router = useRouter()
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault(); setPending(true); setError('')
    const result = mode === 'sign-in' ? await signIn.email({ email, password }) : await signUp.email({ email, password, name })
    setPending(false)
    if (result.error) setError('We could not authenticate with those details.')
    else { router.push('/'); router.refresh() }
  }
  return <main className="flex min-h-screen items-center justify-center bg-background px-5"><div className="w-full max-w-md rounded-3xl border border-border bg-card p-8 shadow-sm"><p className="font-serif text-2xl font-semibold">Local Newsroom</p><p className="mt-2 text-muted-foreground">{mode === 'sign-in' ? 'Sign in to access your private newsroom.' : 'Create your private newsroom account.'}</p><form onSubmit={submit} className="mt-8 flex flex-col gap-4">{mode === 'sign-up' && <label className="flex flex-col gap-2 text-sm font-medium">Name<input required value={name} onChange={(event) => setName(event.target.value)} className="rounded-xl border border-border bg-background px-3 py-2.5" /></label>}<label className="flex flex-col gap-2 text-sm font-medium">Email<input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} className="rounded-xl border border-border bg-background px-3 py-2.5" /></label><label className="flex flex-col gap-2 text-sm font-medium">Password<input required minLength={8} type="password" value={password} onChange={(event) => setPassword(event.target.value)} className="rounded-xl border border-border bg-background px-3 py-2.5" /></label>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<button disabled={pending} className="rounded-xl bg-foreground px-4 py-3 font-semibold text-background disabled:opacity-60">{pending ? 'Please wait…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}</button></form><button onClick={() => setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')} className="mt-5 text-sm text-muted-foreground underline underline-offset-4">{mode === 'sign-in' ? 'Need an account? Create one' : 'Already have an account? Sign in'}</button></div></main>
}
