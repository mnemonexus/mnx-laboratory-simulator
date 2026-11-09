// The add-on's content (catalogue packs and curated definitions), installed from the asset files
// it ships, so tests can call catalogue() and practicals() as the running add-on does.
import { installContentFromDisk } from './content.node'
installContentFromDisk()
