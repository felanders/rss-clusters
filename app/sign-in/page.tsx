'use client'

import { FormEvent, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight, Eye, EyeOff, LockKeyhole, Newspaper } from 'lucide-react'
import { signIn, signUp } from '@/lib/auth-client'

export default function SignInPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in')
  const isSignIn = mode === 'sign-in'
  async function submit(event: FormEvent) {
    event.preventDefault(); setPending(true); setError('')
    try {
      const result = isSignIn ? await signIn.email({ email, password }) : await signUp.email({ email, password, name: email.split('@')[0] })
      if (result.error) setError(!isSignIn && result.error.message ? result.error.message : 'We could not authenticate with those details. Check your email and password, then try again.')
      else { router.replace('/'); router.refresh() }
    } catch {
      setError('The login service is temporarily unavailable. Please try again.')
    } finally {
      setPending(false)
    }
  }
  const [showPassword, setShowPassword] = useState(false)
  return <main className="min-h-screen bg-white text-neutral-950"><div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-6 py-6 sm:px-10 lg:px-16"><header className="flex items-center justify-between"><a href="/sign-in" className="flex items-center gap-2 text-sm font-semibold tracking-tight"><span className="flex size-8 items-center justify-center rounded-full bg-black text-white"><Newspaper className="size-4" /></span>Newsroom</a><span className="text-xs text-neutral-400">Private reading, made simple</span></header><div className="grid flex-1 items-center gap-12 py-16 lg:grid-cols-[1fr_420px] lg:gap-24"><section className="hidden lg:block"><p className="mb-5 text-xs font-semibold uppercase tracking-[0.2em] text-neutral-400">A quieter way to read</p><h1 className="max-w-xl text-6xl font-semibold leading-[0.95] tracking-[-0.07em]">Your news,<br />without the noise.</h1><p className="mt-7 max-w-md text-lg leading-relaxed text-neutral-500">Bring your sources together, follow what matters, and keep your attention on the story.</p></section><section className="w-full"><div className="mb-8"><div className="mb-4 flex size-11 items-center justify-center rounded-2xl bg-black text-white"><LockKeyhole className="size-5" /></div><h2 className="text-3xl font-semibold tracking-[-0.05em]">{isSignIn ? 'Welcome back.' : 'Create your account.'}</h2><p className="mt-2 text-sm text-neutral-500">{isSignIn ? 'Sign in to continue to your newsroom.' : 'Create an account for this private newsroom.'}</p></div><form onSubmit={submit} className="flex flex-col gap-5"><label className="flex flex-col gap-2 text-sm font-medium">Email<input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" className="h-12 rounded-xl border border-neutral-200 bg-white px-4 outline-none transition focus:border-black focus:ring-2 focus:ring-black/10" /></label><label className="flex flex-col gap-2 text-sm font-medium">Password<div className="relative"><input required minLength={8} type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={isSignIn ? 'current-password' : 'new-password'} className="h-12 w-full rounded-xl border border-neutral-200 bg-white px-4 pr-12 outline-none transition focus:border-black focus:ring-2 focus:ring-black/10" /><button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword((current) => !current)} className="absolute inset-y-0 right-0 px-4 text-neutral-400 hover:text-black">{showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</button></div></label>{error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}<button disabled={pending} className="group flex h-12 items-center justify-center gap-2 rounded-xl bg-black px-4 font-semibold text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50">{pending ? 'Please wait…' : isSignIn ? 'Sign in' : 'Create account'}{!pending && <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />}</button></form><button type="button" onClick={() => { setMode(isSignIn ? 'sign-up' : 'sign-in'); setError('') }} className="mt-5 w-full text-center text-sm text-neutral-500 hover:text-neutral-950">{isSignIn ? 'Need an account? Create one' : 'Already have an account? Sign in'}</button><button onClick={() => undefined} hidden className="mt-6 text-sm text-neutral-500 hover:text-black">{isSignIn ? 'Need an account? ' : 'Already have an account? '}<span className="font-semibold text-black underline underline-offset-4">{isSignIn ? 'Create one' : 'Sign in'}</span></button></section></div><footer className="text-xs text-neutral-400">Your feeds and reading history stay private.</footer></div></main>
}
