// One Function for the admin-only reads (see api/_lib/dispatch.ts): /api/admin/ops, /api/admin/trace.
import { dispatcher } from '../_lib/dispatch.js'
import ops from '../_routes/admin_ops.js'
import trace from '../_routes/admin_trace.js'

export const maxDuration = 30

export default dispatcher('admin', { ops, trace })
