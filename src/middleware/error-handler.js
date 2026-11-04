export function errorHandler(error, request, response, next) {
  if (response.headersSent) return next(error);

  const status =
    error?.code === "INVALID_QUERY"
      ? 400
      : error?.type === "entity.parse.failed"
        ? 400
        : error?.type === "entity.too.large"
          ? 413
          : 500;
  const isClientError = status < 500;

  if (!isClientError) {
    console.error("API request failed.", {
      method: request.method,
      status,
    });
  }

  response.status(status).json({
    success: false,
    message: isClientError
      ? error?.code === "INVALID_QUERY"
        ? error.safeMessage
        : status === 400
          ? "The request body contains invalid JSON"
          : "The request body is too large"
      : "An unexpected server error occurred",
    code:
      error?.code === "INVALID_QUERY"
        ? "INVALID_QUERY"
        : status === 400
          ? "INVALID_JSON"
          : status === 413
            ? "PAYLOAD_TOO_LARGE"
            : "INTERNAL_SERVER_ERROR",
    details: null,
  });
}
