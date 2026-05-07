import React, { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import useAuthStore from '../store/authStore.js'
import './AuthPage.css'

// ── Eye icon SVGs ─────────────────────────────────────────────────────────────
function EyeOpen() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  )
}

function EyeOff() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
    </svg>
  )
}

// ── Password strength indicator ───────────────────────────────────────────────
function getStrength(pw) {
  if (!pw) return { level: 0, label: '', color: '' }
  let score = 0
  if (pw.length >= 8)  score++
  if (pw.length >= 12) score++
  if (/[A-Z]/.test(pw)) score++
  if (/[0-9]/.test(pw)) score++
  if (/[^A-Za-z0-9]/.test(pw)) score++
  if (score <= 1) return { level: 1, label: 'Weak',   color: '#f87171' }
  if (score <= 3) return { level: 2, label: 'Fair',   color: '#fb923c' }
  if (score === 4) return { level: 3, label: 'Good',  color: '#facc15' }
  return              { level: 4, label: 'Strong', color: '#4ade80' }
}

export default function AuthPage({ mode }) {
  const navigate = useNavigate()
  const { login, register, isLoading, error, clearError } = useAuthStore()

  const [username,     setUsername]     = useState('')
  const [displayName,  setDisplayName]  = useState('')
  const [password,     setPassword]     = useState('')
  const [confirm,      setConfirm]      = useState('')
  const [keyStep,      setKeyStep]      = useState(null)   

  // Password visibility toggles
  const [showPw,      setShowPw]      = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)

  // Field-level validation errors
  const [fieldErrors, setFieldErrors] = useState({})

  const isReg = mode === 'register'
  const strength = isReg ? getStrength(password) : null

  // ── Validation ──────────────────────────────────────────────────────────────
  const validate = () => {
    const errs = {}
    if (!username.trim())          errs.username = 'Username is required'
    else if (username.trim().length < 3) errs.username = 'Username must be at least 3 characters'
    else if (username.trim().length > 32) errs.username = 'Username must be 32 characters or fewer'
    else if (!/^[a-zA-Z0-9_]+$/.test(username.trim())) errs.username = 'Only letters, numbers and underscores'

    if (!password)                 errs.password = 'Password is required'
    else if (password.length < 8)  errs.password = 'Password must be at least 8 characters'
    else if (password.length > 128) errs.password = 'Password must be 128 characters or fewer'

    if (isReg) {
      if (displayName.length > 128) errs.displayName = 'Display name must be 128 characters or fewer'
      if (!confirm)                 errs.confirm = 'Please confirm your password'
      else if (password !== confirm) errs.confirm = 'Passwords do not match'
    }
    return errs
  }

  // ── Submit ──────────────────────────────────────────────────────────────────
  const handleSubmit = async (e) => {
    e.preventDefault()
    clearError()
    const errs = validate()
    setFieldErrors(errs)
    if (Object.keys(errs).length > 0) return

    if (isReg) {
      setKeyStep('generating')
      const res = await register(username.trim(), password, displayName.trim() || username.trim())
      if (res.success) {
        setKeyStep('done')
        setTimeout(() => navigate('/chat'), 700)
      } else {
        setKeyStep(null)
      }
    } else {
      const res = await login(username.trim(), password)
      if (res.success) navigate('/chat')
    }
  }

  const handleUsernameChange = (v) => {
    setUsername(v)
    if (fieldErrors.username) setFieldErrors((p) => ({ ...p, username: '' }))
  }
  const handlePasswordChange = (v) => {
    setPassword(v)
    if (fieldErrors.password) setFieldErrors((p) => ({ ...p, password: '' }))
  }
  const handleConfirmChange = (v) => {
    setConfirm(v)
    if (fieldErrors.confirm) setFieldErrors((p) => ({ ...p, confirm: '' }))
  }

  return (
    <div className="auth-root">
      <div className="auth-bg" aria-hidden="true">
        <div className="auth-bg-grid" />
        <div className="auth-bg-glow" />
      </div>

      <div className="auth-card fade-in">
        <div className="auth-header">
          <div className="auth-logo">
            <span>🔒</span>
            <span className="auth-logo-name">WhisperBox</span>
          </div>
          <p className="auth-tagline">End-to-end encrypted. Always.</p>
        </div>

        {/* Key generation banner */}
        {isReg && keyStep && (
          <div className="keygen-banner fade-in">
            {keyStep === 'generating'
              ? <><div className="spinner" /><span>Generating RSA-4096 key pair… (this takes a moment)</span></>
              : <><span>✓</span><span>Keys ready. Private key secured on device.</span></>
            }
          </div>
        )}

        <form className="auth-form" onSubmit={handleSubmit} noValidate>

          {/* Username */}
          <div className="form-group">
            <label className="form-label">Username</label>
            <input
              className={`input ${fieldErrors.username ? 'input-error' : ''}`}
              type="text"
              placeholder="your_username"
              value={username}
              onChange={(e) => handleUsernameChange(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
            />
            {fieldErrors.username && <p className="form-hint-error">⚠ {fieldErrors.username}</p>}
          </div>

          {/* Display name (register only) */}
          {isReg && (
            <div className="form-group">
              <label className="form-label">Display Name <span className="form-optional">(optional)</span></label>
              <input
                className={`input ${fieldErrors.displayName ? 'input-error' : ''}`}
                type="text"
                placeholder="Your Name"
                value={displayName}
                onChange={(e) => { setDisplayName(e.target.value); if (fieldErrors.displayName) setFieldErrors((p) => ({ ...p, displayName: '' })) }}
                autoComplete="name"
              />
              {fieldErrors.displayName && <p className="form-hint-error">⚠ {fieldErrors.displayName}</p>}
            </div>
          )}

          {/* Password */}
          <div className="form-group">
            <label className="form-label">Password</label>
            <div className="input-password-wrap">
              <input
                className={`input input-pw ${fieldErrors.password ? 'input-error' : ''}`}
                type={showPw ? 'text' : 'password'}
                placeholder="••••••••"
                value={password}
                onChange={(e) => handlePasswordChange(e.target.value)}
                autoComplete={isReg ? 'new-password' : 'current-password'}
              />
              <button
                type="button"
                className="eye-btn"
                onClick={() => setShowPw((v) => !v)}
                aria-label={showPw ? 'Hide password' : 'Show password'}
              >
                {showPw ? <EyeOff /> : <EyeOpen />}
              </button>
            </div>
            {fieldErrors.password && <p className="form-hint-error">⚠ {fieldErrors.password}</p>}

            {/* Strength meter (register only) */}
            {isReg && password && (
              <div className="strength-meter">
                <div className="strength-bars">
                  {[1,2,3,4].map((n) => (
                    <div key={n} className="strength-bar"
                      style={{ background: n <= strength.level ? strength.color : 'var(--bg-hover)' }} />
                  ))}
                </div>
                <span className="strength-label" style={{ color: strength.color }}>
                  {strength.label}
                </span>
              </div>
            )}
          </div>

          {/* Confirm password (register only) */}
          {isReg && (
            <div className="form-group">
              <label className="form-label">Confirm Password</label>
              <div className="input-password-wrap">
                <input
                  className={`input input-pw ${fieldErrors.confirm ? 'input-error' : (confirm && password === confirm ? 'input-success' : '')}`}
                  type={showConfirm ? 'text' : 'password'}
                  placeholder="••••••••"
                  value={confirm}
                  onChange={(e) => handleConfirmChange(e.target.value)}
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  className="eye-btn"
                  onClick={() => setShowConfirm((v) => !v)}
                  aria-label={showConfirm ? 'Hide password' : 'Show password'}
                >
                  {showConfirm ? <EyeOff /> : <EyeOpen />}
                </button>
              </div>
              {fieldErrors.confirm
                ? <p className="form-hint-error">⚠ {fieldErrors.confirm}</p>
                : confirm && password === confirm
                  ? <p className="form-hint-ok">✓ Passwords match</p>
                  : null
              }
            </div>
          )}

          {/* API / store-level error */}
          {error && (
            <div className="banner banner-error" role="alert">
              <span>⚠</span>
              <span>{error}</span>
            </div>
          )}

          {/* E2EE notice (register only) */}
          {isReg && (
            <div className="auth-notice">
              <span className="lock-badge">🔑 E2EE</span>
              <p>An RSA-4096 key pair will be generated in your browser.
                Your private key is encrypted with your password and never leaves this device in plaintext.</p>
            </div>
          )}

          <button
            className="btn btn-primary auth-submit"
            type="submit"
            disabled={isLoading || (isReg && !!confirm && password !== confirm)}
          >
            {isLoading
              ? <><div className="spinner" />{isReg ? 'Creating account…' : 'Signing in…'}</>
              : isReg ? 'Create Encrypted Account' : 'Sign In'
            }
          </button>
        </form>

        <div className="auth-footer">
          {isReg
            ? <p>Have an account? <Link to="/login">Sign in</Link></p>
            : <p>New here? <Link to="/register">Create account</Link></p>
          }
        </div>

      </div>
    </div>
  )
}
