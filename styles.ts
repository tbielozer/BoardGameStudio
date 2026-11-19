import { StyleSheet } from 'react-native';
export const styles = StyleSheet.create({
  // STYLE SECTION
  // This is where all of the visual design is stored.
  // Each object below controls the look of a part of the app: the home screen,
  // buttons, menu, mat, and symbol panels.
  // If a section of the UI is not looking right, this is usually the place to fix it.

  //Home Screen
  screen: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: '#F3F4F6',
  },
  title: {
    marginBottom: 32,
    color: '#111827',
    fontSize: 32,
    fontWeight: '700',
  },

  //Menu Buttons
  buttons: {
    width: '100%',
    maxWidth: 360,
  },
  buttonsLandscape: {
    flexDirection: 'row',
    maxWidth: 900,
    gap: 12,
  },
  buttonPortrait: {
    width: '100%',
    marginBottom: 14,
  },
  buttonLandscape: {
    flex: 1,
  },
  button: {
    maxWidth: 360,
    alignItems: 'center',
    paddingVertical: 16,
    borderRadius: 12,
    backgroundColor: '#ffffff',
    borderWidth: 2,
    borderColor: '#000000'
  },
  buttonPressed: {
    backgroundColor: '#00ff3c',
    // opacity: 0.5,
  },
  buttonText: {
    color: '#000000',
    fontSize: 18,
    fontWeight: '600',
  },

  //Create Game Screen
  createScreen: {
    flex: 1,
    padding: 24,
    backgroundColor: '#F3F4F6',
  },
  createHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  createTitle: {
    color: '#111827',
    fontSize: 28,
    fontWeight: '700',
  },

  //Menu Dropdown
  menuButton: {
    position: 'absolute',
    // top: 5,
    // right: 5,
    // Keep the menu controls above the drawing toolbar when the two overlap.
    zIndex: 50,
    elevation: 50,
    padding: 12,
    borderWidth: 1,
    borderColor: '#9CA3AF',
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    opacity: 0.75,
  },
  menuButtonText: {
    color: '#000000',
    fontSize: 16,
  },
  dropdown: {
    position: 'absolute',
    // top: 0,
    // right: 0,
    bottom: 0,
    width: '20%',
    maxWidth: 360,
    // This sidebar is rendered after the board but still needs to sit above
    // the canvas toolbar, which has its own elevated layer.
    zIndex: 50,
    elevation: 50,
    borderWidth: 1,
    borderColor: '#9CA3AF',
    // borderRadius: 10,
    backgroundColor: '#FFFFFF',
    overflow: 'hidden',
    opacity: 0.75,
  },
  menuTitle: {
    color: '#111827',
    fontSize: 18,
    fontWeight: '700',
  },
  menuOptionsScroll: {
    flex: 1,
    minHeight: 0,
  },
  menuOptionsContent: {
    flexGrow: 1,
    paddingBottom: 8,
  },
  spotSetupHelperText: {
    color: '#4B5563',
    fontSize: 14,
    lineHeight: 20,
  },
  menuOption: {
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  tokenSupplyChoice: {
    minHeight: 64,
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  tokenSupplyChoiceName: {
    color: '#111827',
    fontSize: 16,
    fontWeight: '600',
  },
  tokenSupplyChoiceDetails: {
    color: '#6B7280',
    fontSize: 13,
  },
  menuHeader: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 14,
    paddingRight: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#D1D5DB',
  },
  closeButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: {
    color: '#111827',
    fontSize: 28,
  },

  //Mat Placeholder
  matPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },


  gameCanvas: {
    flex: 1,
    position: 'relative',
    backgroundColor: '#F3F4F6',
  },

  //Filler so top doesn't look like weird cut off
  topLine: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: '#6d706d',
    zIndex: 10,
  },

  //Symbols 
  symbolsScreen: {
    flex: 1,
    padding: 24,
    gap: 12,
    backgroundColor: '#F3F4F6',
  },

  symbolRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 16,
    paddingRight: 8,
    borderWidth: 1,
    borderColor: '#9CA3AF',
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
  },

  symbolOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 4,
    elevation: 10,
  },
  symbolPanel: {
    width: '88%',
    height: '88%',
    borderWidth: 1,
    borderColor: '#9CA3AF',
    borderRadius: 12,
    backgroundColor: 'rgba(255, 255, 255, 1)',
    overflow: 'hidden',
  },
  symbolPageContent: {
    flex: 1,
    padding: 20,
    gap: 12,
  },

  libraryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },

  libraryHeaderActions: {
    flexDirection: 'row',
    gap: 8,
  },

  libraryIconButton: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#9CA3AF',
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
  },

  libraryIconText: {
    color: '#111827',
    fontSize: 26,
  },

  backArrowText: {
    transform: [{ translateY: -4 }],
  },

  symbolNameButton: {
    flex: 1,
    paddingVertical: 16,
  },

  deleteButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  
  deleteButtonText: {
    color: '#B91C1C',
    fontSize: 20,
  },


  renameButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  renameButtonText: {
    color: '#111827',
    fontSize: 22,
  },
  renameBackdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
  },
  renameDialog: {
    width: '100%',
    maxWidth: 360,
    gap: 12,
    padding: 20,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
  },
  renameInput: {
    borderWidth: 1,
    borderColor: '#9CA3AF',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
  },
  renameActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
  },
  renameActionButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#E5E7EB',
  },

  symbolDrawingAreaContainer: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },

  symbolDrawingArea: {
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#9CA3AF',
    borderRadius: 8,
  },

  projectPickerScreen: {
    flex: 1,
    padding: 24,
    paddingBottom: 16,
    backgroundColor: '#F3F4F6',
  },

  projectPickerButton: {
    width: '100%',
    maxWidth: 360,
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    borderWidth: 2,
    borderColor: '#000000',
  },

  projectPickerButtonPressed: {
    backgroundColor: '#E5E7EB',
  },

  projectPickerButtonText: {
    color: '#111827',
    fontSize: 18,
    fontWeight: '600',
  },

  projectScroll: {
    flex: 1,
    marginTop: 16,
  },

  projectGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignContent: 'flex-start',
    justifyContent: 'flex-start',
    gap: 12,
  },

  projectCard: {
    width: 150,
    height: 120,
    padding: 10,
    borderWidth: 1,
    borderColor: '#9CA3AF',
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
  },

  projectCardMain: {
    maxWidth: 360,
    flex: 1,
    justifyContent: 'center',
  },

  projectName: {
    color: '#111827',
    fontSize: 16,
    fontWeight: '600',
  },

  projectDeleteButton: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 2,
    width: 40,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },

  projectRenameButton: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 42,
    width: 40,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },

  projectActions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
    paddingTop: 12,
  },

  projectActionButton: {
    flex: 1,
    maxWidth: 180,
    alignItems: 'center',
    paddingVertical: 14,
    borderWidth: 2,
    borderColor: '#000000',
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
  },

  projectActionText: {
    color: '#111827',
    fontSize: 16,
    fontWeight: '600',
  },

  projectTile: {
    width: '48%',
    maxWidth: 240,
    position: 'relative',
  },

  projectTileButton: {
    width: '100%',
    maxWidth: 260,
    paddingHorizontal: 28,
  },

  projectTileText: {
    textAlign: 'center',
    paddingHorizontal: 4,
  },
});
