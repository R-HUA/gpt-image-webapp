import { describe, expect, it } from 'vitest'
import nginxConfig from '../../deploy/nginx.conf?raw'

describe('deploy nginx config', () => {
  it('does not allow full URL referrers to leak credentials', () => {
    expect(nginxConfig).toContain('Referrer-Policy "no-referrer"')
    expect(nginxConfig).not.toContain('Referrer-Policy "unsafe-url"')
  })
})
