import { Runtime } from 'foldkit'
import {
  init,
  managedResources,
  Message,
  Model,
  subscriptions,
  update,
  view,
} from './main.ts'

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  subscriptions,
  managedResources,
  container: document.getElementById('root'),
  devTools: {
    Message,
    mode: 'TimeTravel',
  },
  routing: {
    onUrlRequest: request => Message.ClickedLink({ request }),
    onUrlChange: url => Message.ChangedUrl({ url }),
  },
})

Runtime.run(application)
