// First-party N-API wrapper around flock(2) for the Enigma index lock.
//
// Exposes exactly two synchronous operations on an already-open fd:
//   tryLockSync(fd) -> boolean   flock(fd, LOCK_EX | LOCK_NB)
//   unlockSync(fd)   -> void     flock(fd, LOCK_UN)
//
// The kernel associates a flock with the open file description, not with
// the pathname, so this wrapper never touches names: the caller owns the
// anchor file's lifecycle (create once, never rename/unlink/replace) and
// this module only adds the advisory exclusive lock to the description.
// The kernel releases the lock when the fd is closed or the process dies
// by any means (including SIGKILL) — that automatic death release is the
// crash-recovery mechanism (Issue #66).
//
// Built with NAPI_VERSION=8 (ABI-stable across Node >= 20, the repo's
// engines floor). N-API symbols stay undefined at link time and are
// resolved from the node executable at load.

#include <node_api.h>

#include <errno.h>
#include <stdio.h>
#include <sys/file.h>

static int fd_from_args(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < 1) {
    napi_throw_type_error(env, NULL, "expected a single integer fd argument");
    return -1;
  }
  int64_t fd = -1;
  if (napi_get_value_int64(env, argv[0], &fd) != napi_ok || fd < 0) {
    napi_throw_type_error(env, NULL, "fd must be a non-negative integer");
    return -1;
  }
  return (int)fd;
}

static napi_value try_lock_sync(napi_env env, napi_callback_info info) {
  int fd = fd_from_args(env, info);
  if (fd < 0) return NULL;

  napi_value out;
  if (flock(fd, LOCK_EX | LOCK_NB) == 0) {
    napi_get_boolean(env, true, &out);
    return out;
  }
  if (errno == EWOULDBLOCK || errno == EAGAIN) {
    /* Held by another open file description (possibly another process). */
    napi_get_boolean(env, false, &out);
    return out;
  }
  char msg[128];
  snprintf(msg, sizeof msg, "flock(LOCK_EX|LOCK_NB) failed (errno %d)", errno);
  napi_throw_error(env, "E_FLOCK", msg);
  return NULL;
}

static napi_value unlock_sync(napi_env env, napi_callback_info info) {
  int fd = fd_from_args(env, info);
  if (fd < 0) return NULL;

  if (flock(fd, LOCK_UN) != 0) {
    char msg[128];
    snprintf(msg, sizeof msg, "flock(LOCK_UN) failed (errno %d)", errno);
    napi_throw_error(env, "E_FLOCK", msg);
  }
  return NULL;
}

NAPI_MODULE_INIT() {
  napi_value try_fn;
  napi_value unlock_fn;
  if (napi_create_function(env, "tryLockSync", NAPI_AUTO_LENGTH, try_lock_sync, NULL, &try_fn) != napi_ok ||
      napi_set_named_property(env, exports, "tryLockSync", try_fn) != napi_ok ||
      napi_create_function(env, "unlockSync", NAPI_AUTO_LENGTH, unlock_sync, NULL, &unlock_fn) != napi_ok ||
      napi_set_named_property(env, exports, "unlockSync", unlock_fn) != napi_ok) {
    napi_throw_error(env, "E_INIT", "failed to register index-lock exports");
    return NULL;
  }
  return exports;
}
