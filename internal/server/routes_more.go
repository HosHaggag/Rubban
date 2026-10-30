package server

// dispatchMore holds routes added by later phases; unknown routes are 404.
func (b *Backend) dispatchMore(q *request) (any, int, error) {
	return nil, 0, problem("API route not found", 404)
}
