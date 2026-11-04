export function notFound(_request, response) {
  response.status(404).json({
    success: false,
    message: "The requested API route was not found",
    code: "ROUTE_NOT_FOUND",
    details: null,
  });
}
