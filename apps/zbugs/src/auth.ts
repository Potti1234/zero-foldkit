import { Option } from 'effect'
import { decodeJwt } from 'jose'
import type { JWTData } from '../shared/auth.ts'

// The login held by the Model: the raw JWT Zero sends as `auth`, plus its
// decoded claims used for `userID`/`context` and UI state.
export type Login = {
  readonly encoded: string
  readonly decoded: JWTData
}

const readCookie = (name: string): string | undefined => {
  const prefix = `${name}=`
  const entry = document.cookie
    .split('; ')
    .find(row => row.startsWith(prefix))
  return entry
    ? decodeURIComponent(entry.slice(prefix.length))
    : undefined
}

export const getLogin = (): Option.Option<Login> => {
  const encoded = readCookie('jwt')
  if (!encoded) {
    return Option.none()
  }
  const decoded = decodeJwt(encoded) as unknown as JWTData
  if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) {
    return Option.none()
  }
  return Option.some({ encoded, decoded })
}

export const clearJwt = () => {
  document.cookie = 'jwt=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT'
}
