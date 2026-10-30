package server

// A route handler claims a request by returning handled=true. Handlers are registered from init()
// functions in the file that owns the feature, so independent files never need to edit a shared switch.
type routeHandler func(b *Backend, q *request) (result any, status int, handled bool, err error)

var routeHandlers []routeHandler

func registerRoutes(h routeHandler) { routeHandlers = append(routeHandlers, h) }

// dispatchMore tries every registered handler; unclaimed routes are 404.
func (b *Backend) dispatchMore(q *request) (any, int, error) {
	for _, h := range routeHandlers {
		if result, status, handled, err := h(b, q); handled {
			if err != nil {
				return nil, 0, err
			}
			if status == 0 {
				status = 200
			}
			return result, status, nil
		}
	}
	return nil, 0, problem("API route not found", 404)
}
