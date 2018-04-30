// @flow
import React, { Component } from 'react';
import compose from 'recompose/compose';
import Textarea from 'react-textarea-autosize';
import { withRouter } from 'react-router';
import { connect } from 'react-redux';
import isURL from 'validator/lib/isURL';
import debounce from 'debounce';
import queryString from 'query-string';
import { KeyBindingUtil } from 'draft-js';
import { URLS } from '../../helpers/regexps';
import { track } from '../../helpers/events';
import { closeComposer } from '../../actions/composer';
import { changeActiveThread } from '../../actions/dashboardFeed';
import { addToastWithTimeout } from '../../actions/toasts';
import Editor from '../rich-text-editor';
import {
  toPlainText,
  fromPlainText,
  toJSON,
  toState,
} from 'shared/draft-utils';
import getComposerCommunitiesAndChannels from 'shared/graphql/queries/composer/getComposerCommunitiesAndChannels';
import type { GetComposerType } from 'shared/graphql/queries/composer/getComposerCommunitiesAndChannels';
import publishThread from 'shared/graphql/mutations/thread/publishThread';
import { getLinkPreviewFromUrl } from '../../helpers/utils';
import { TextButton, Button } from '../buttons';
import { FlexRow } from '../../components/globals';
import { LoadingSelect } from '../loading';
import {
  Container,
  ThreadDescription,
  ThreadTitle,
  ThreadInputs,
  Actions,
  RequiredSelector,
  DisabledWarning,
} from './style';
import { sortCommunities, sortChannels } from './utils';

const ENDS_IN_WHITESPACE = /(\s|\n)$/;

type State = {
  title: string,
  body: Object,
  availableCommunities: Array<any>,
  availableChannels: Array<any>,
  activeCommunity: ?string,
  activeChannel: ?string,
  isPublishing: boolean,
  linkPreview: ?Object,
  linkPreviewTrueUrl: ?string,
  linkPreviewLength: number,
  fetchingLinkPreview: boolean,
  postWasPublished: boolean,
};

type Props = {
  data: {
    user: GetComposerType,
    refetch: Function,
    loading: boolean,
  },
  isOpen: boolean,
  dispatch: Function,
  publishThread: Function,
  history: Object,
  location: Object,
  activeCommunity?: string,
  activeChannel?: string,
  threadSliderIsOpen?: boolean,
  isInbox: boolean,
  websocketConnection: string,
  networkOnline: boolean,
};

const LS_BODY_KEY = 'last-thread-composer-body';
const LS_TITLE_KEY = 'last-thread-composer-title';
// We persist the body and title to localStorage
// so in case the app crashes users don't loose content
class ComposerWithData extends Component<Props, State> {
  bodyEditor: any;

  constructor(props) {
    super(props);

    let storedBody;
    let storedTitle;
    if (localStorage) {
      try {
        storedBody = toState(
          JSON.parse(localStorage.getItem(LS_BODY_KEY) || '')
        );
        storedTitle = localStorage.getItem(LS_TITLE_KEY);
      } catch (err) {
        localStorage.removeItem(LS_BODY_KEY);
        localStorage.removeItem(LS_TITLE_KEY);
      }
    }

    this.state = {
      title: storedTitle || '',
      body: storedBody || fromPlainText(''),
      availableCommunities: [],
      availableChannels: [],
      activeCommunity: '',
      activeChannel: '',
      isPublishing: false,
      linkPreview: null,
      linkPreviewTrueUrl: '',
      linkPreviewLength: 0,
      fetchingLinkPreview: false,
      postWasPublished: false,
    };

    this.persistBodyToLocalStorageWithDebounce = debounce(
      this.persistBodyToLocalStorageWithDebounce,
      500
    );
    this.persistTitleToLocalStorageWithDebounce = debounce(
      this.persistTitleToLocalStorageWithDebounce,
      500
    );
  }

  handleIncomingProps = props => {
    const { user } = props.data;
    // if the user doesn't exist, bust outta here
    if (!user || !user.id) return;

    const hasCommunities =
      user.communityConnection.edges &&
      user.communityConnection.edges.length > 0;
    const hasChannels =
      user.channelConnection.edges && user.channelConnection.edges.length > 0;

    if (!hasCommunities || !hasChannels) {
      return this.setState({
        availableCommunities: [],
        availableChannels: [],
        activeCommunity: '',
        activeChannel: '',
      });
    }

    const communities = sortCommunities(
      user.communityConnection.edges
        // $FlowFixMe
        .map(edge => edge && edge.node)
        .filter(Boolean)
    );

    const channels = sortChannels(
      user.channelConnection.edges
        // $FlowFixMe
        .map(edge => edge && edge.node)
        .filter(channel => channel && !channel.isArchived)
        .filter(Boolean)
    );

    const activeSlug = props.activeCommunity || this.state.activeCommunity;
    let community = null;

    // User is viewing a community/channel? Use the community from the URL
    if (activeSlug) {
      community = communities.find(
        community => community.slug.toLowerCase() === activeSlug.toLowerCase()
      );
    }

    // get the channels for the active community
    const communityChannels = channels
      .filter(
        channel => channel && community && channel.community.id === community.id
      )
      .filter(channel => channel && !channel.isArchived);

    this.setState({
      availableCommunities: communities,
      availableChannels:
        communityChannels.length > 0 ? communityChannels : channels,
      activeCommunity: !community ? '' : community.id,
      activeChannel: '',
    });
  };

  componentWillMount() {
    let storedBody;
    let storedTitle;
    if (localStorage) {
      try {
        storedBody = toState(
          JSON.parse(localStorage.getItem(LS_BODY_KEY) || '')
        );
        storedTitle = localStorage.getItem(LS_TITLE_KEY);
      } catch (err) {
        localStorage.removeItem(LS_BODY_KEY);
        localStorage.removeItem(LS_TITLE_KEY);
      }
    }

    this.setState({
      title: this.state.title || storedTitle || '',
      body: this.state.body || storedBody || '',
    });
  }

  componentDidMount() {
    this.handleIncomingProps(this.props);
    // $FlowIssue
    document.addEventListener('keydown', this.handleKeyPress, false);
  }

  componentWillUnmount() {
    // $FlowIssue
    document.removeEventListener('keydown', this.handleKeyPress, false);
    const { postWasPublished } = this.state;

    // if a post was published, in this session, clear redux so that the next
    // composer open will start fresh
    if (postWasPublished) return this.closeComposer('clear');

    // otherwise, clear the composer normally and save the state
    return this.closeComposer();
  }

  handleKeyPress = e => {
    const esc = e.keyCode === 27;
    const cmdEnter = e.keyCode === 13 && KeyBindingUtil.hasCommandModifier(e);

    if (esc) {
      // Community/channel view
      this.closeComposer();
      // Dashboard
      this.activateLastThread();
      return;
    }

    if (cmdEnter) return this.publishThread();
  };

  activateLastThread = () => {
    // we get the last thread id from the query params and dispatch it
    // as the active thread.
    const { location } = this.props;
    const { t: threadId } = queryString.parse(location.search);

    this.props.dispatch(changeActiveThread(threadId));
  };

  changeTitle = e => {
    const title = e.target.value;
    this.persistTitleToLocalStorageWithDebounce(title);
    if (/\n$/g.test(title)) {
      this.bodyEditor.focus();
      return;
    }
    this.setState({
      title,
    });
  };

  changeBody = body => {
    this.listenForUrl(body);
    this.persistBodyToLocalStorageWithDebounce(body);
    this.setState({
      body,
    });
  };

  componentWillUpdate(next) {
    const currChannelLength =
      this.props.data.user &&
      this.props.data.user.channelConnection.edges.length;
    const nextChannelLength =
      next.data.user && next.data.user.channelConnection.edges.length;
    const currCommunityLength =
      this.props.data.user &&
      this.props.data.user.communityConnection.edges.length;
    const nextCommunityLength =
      next.data.user && next.data.user.communityConnection.edges.length;

    if (
      (this.props.data.loading && !next.data.loading) ||
      currChannelLength !== nextChannelLength ||
      currCommunityLength !== nextCommunityLength
    ) {
      this.handleIncomingProps(next);
    }
  }

  closeComposer = (clear?: string) => {
    this.persistBodyToLocalStorage(this.state.body);
    this.persistTitleToLocalStorage(this.state.title);
    // we will clear the composer if it unmounts as a result of a post
    // being published, that way the next composer open will start fresh
    if (clear) {
      this.clearEditorStateAfterPublish();
    }

    return this.props.dispatch(closeComposer());
  };

  clearEditorStateAfterPublish = () => {
    try {
      localStorage.removeItem(LS_BODY_KEY);
      localStorage.removeItem(LS_TITLE_KEY);
    } catch (err) {
      console.error(err);
    }
  };

  onCancelClick = () => {
    this.activateLastThread();
  };

  persistBodyToLocalStorageWithDebounce = body => {
    if (!localStorage) return;
    return localStorage.setItem(
      LS_BODY_KEY,
      JSON.stringify(toJSON(this.state.body))
    );
  };

  persistTitleToLocalStorageWithDebounce = title => {
    if (!localStorage) return;
    return localStorage.setItem(LS_TITLE_KEY, this.state.title);
  };

  persistTitleToLocalStorage = title => {
    if (!localStorage) return;
    return localStorage.setItem(LS_TITLE_KEY, this.state.title);
  };

  persistBodyToLocalStorage = body => {
    if (!localStorage) return;
    return localStorage.setItem(
      LS_BODY_KEY,
      JSON.stringify(toJSON(this.state.body))
    );
  };

  setActiveCommunity = e => {
    const newActiveCommunity = e.target.value;
    const newActiveCommunityData = this.state.availableCommunities.find(
      community => community.id === newActiveCommunity
    );
    this.setState({
      activeCommunity: newActiveCommunityData.id,
      activeChannel: '',
    });
  };

  setActiveChannel = e => {
    const activeChannel = e.target.value;

    this.setState({
      activeChannel,
    });
  };

  publishThread = () => {
    // if no title and no channel is set, don't allow a thread to be published
    if (
      !this.state.title ||
      !this.state.activeChannel ||
      !this.state.activeCommunity
    ) {
      return;
    }

    // isPublishing will change the publish button to a loading spinner
    this.setState({
      isPublishing: true,
    });

    const { dispatch, networkOnline, websocketConnection } = this.props;

    if (!networkOnline) {
      return dispatch(
        addToastWithTimeout(
          'error',
          'Not connected to the internet - check your internet connection or try again'
        )
      );
    }

    if (
      websocketConnection !== 'connected' &&
      websocketConnection !== 'reconnected'
    ) {
      return dispatch(
        addToastWithTimeout(
          'error',
          'Error connecting to the server - hang tight while we try to reconnect'
        )
      );
    }

    // define new constants in order to construct the proper shape of the
    // input for the publishThread mutation
    const {
      activeChannel,
      activeCommunity,
      title,
      body,
      linkPreview,
      linkPreviewTrueUrl,
    } = this.state;
    const channelId = activeChannel;
    const communityId = activeCommunity;
    const jsonBody = toJSON(body);

    const content = {
      title: title.trim(),
      body: JSON.stringify(jsonBody),
    };

    const attachments = [];
    if (linkPreview) {
      const attachmentData = JSON.stringify({
        ...linkPreview,
        trueUrl: linkPreviewTrueUrl,
      });
      attachments.push({
        attachmentType: 'linkPreview',
        data: attachmentData,
      });
    }

    // Get the images
    const filesToUpload = Object.keys(jsonBody.entityMap)
      .filter(key => jsonBody.entityMap[key].type === 'image')
      .map(key => jsonBody.entityMap[key].data.file);

    // this.props.mutate comes from a higher order component defined at the
    // bottom of this file
    const thread = {
      channelId,
      communityId,
      type: 'DRAFTJS',
      content,
      attachments,
      filesToUpload,
    };

    // one last save to localstorage
    this.persistBodyToLocalStorage(this.state.body);
    this.persistTitleToLocalStorage(this.state.title);

    this.props
      .publishThread(thread)
      // after the mutation occurs, it will either return an error or the new
      // thread that was published
      .then(({ data }) => {
        // get the thread id to redirect the user
        const id = data.publishThread.id;

        track('thread', 'published', null);
        this.clearEditorStateAfterPublish();

        // stop the loading spinner on the publish button
        this.setState({
          isPublishing: false,
          postWasPublished: true,
        });

        // redirect the user to the thread
        // if they are in the inbox, select it
        this.props.dispatch(
          addToastWithTimeout('success', 'Thread published!')
        );
        if (this.props.isInbox) {
          this.props.history.replace(`/?t=${id}`);
          this.props.dispatch(changeActiveThread(id));
        } else if (this.props.location.pathname === '/new/thread') {
          this.props.history.replace(`/?thread=${id}`);
        } else {
          this.props.history.push(`?thread=${id}`);
          this.props.dispatch(changeActiveThread(null));
        }
        return;
      })
      .catch(err => {
        this.setState({
          isPublishing: false,
        });
        this.props.dispatch(addToastWithTimeout('error', err.message));
      });
  };

  listenForUrl = state => {
    const { linkPreview, linkPreviewLength } = this.state;
    if (linkPreview !== null) return;

    const lastChangeType = state.getLastChangeType();
    if (
      lastChangeType !== 'backspace-character' &&
      lastChangeType !== 'insert-characters'
    ) {
      return;
    }

    const text = toPlainText(state);

    if (!ENDS_IN_WHITESPACE.test(text)) return;

    const toCheck = text.match(URLS);

    if (toCheck) {
      const len = toCheck.length;
      if (linkPreviewLength === len) return; // no new links, don't recheck

      let urlToCheck = toCheck[len - 1].trim();

      if (!/^https?:\/\//i.test(urlToCheck)) {
        urlToCheck = 'https://' + urlToCheck;
      }

      if (!isURL(urlToCheck)) return;

      this.setState({ fetchingLinkPreview: true });

      getLinkPreviewFromUrl(urlToCheck)
        .then(data =>
          this.setState(prevState => ({
            linkPreview: { ...data, trueUrl: urlToCheck },
            linkPreviewTrueUrl: urlToCheck,
            linkPreviewLength: prevState.linkPreviewLength + 1,
            fetchingLinkPreview: false,
          }))
        )
        .catch(() => {
          this.setState({
            fetchingLinkPreview: false,
          });
          this.props.dispatch(
            addToastWithTimeout(
              'error',
              `Oops, we couldn't fetch a preview for ${urlToCheck}. You can publish your story anyways though! 👍`
            )
          );
        });
    }
  };

  removeLinkPreview = () => {
    this.setState({
      linkPreview: null,
      linkPreviewTrueUrl: null,
    });
  };

  render() {
    const {
      title,
      availableChannels,
      availableCommunities,
      activeCommunity,
      activeChannel,
      isPublishing,
      linkPreview,
      linkPreviewTrueUrl,
      fetchingLinkPreview,
    } = this.state;

    const {
      data: { user },
      threadSliderIsOpen,
      networkOnline,
      websocketConnection,
    } = this.props;
    const dataExists = user && availableCommunities && availableChannels;

    const networkDisabled =
      !networkOnline ||
      (websocketConnection !== 'connected' &&
        websocketConnection !== 'reconnected');
    return (
      <Container>
        <ThreadInputs>
          <Textarea
            data-cy="composer-title-input"
            onChange={this.changeTitle}
            style={ThreadTitle}
            value={this.state.title}
            placeholder={"What's up?"}
            ref={'titleTextarea'}
            autoFocus={!threadSliderIsOpen}
          />

          <Editor
            version={2}
            onChange={this.changeBody}
            state={this.state.body}
            style={ThreadDescription}
            editorRef={editor => (this.bodyEditor = editor)}
            editorKey="thread-composer"
            placeholder={'Write more thoughts here...'}
            className={'threadComposer'}
            showLinkPreview={true}
            linkPreview={{
              loading: fetchingLinkPreview,
              remove: this.removeLinkPreview,
              trueUrl: linkPreviewTrueUrl,
              data: linkPreview,
            }}
          />
        </ThreadInputs>

        <Actions>
          {networkDisabled && (
            <DisabledWarning>
              Lost connection to the internet or server...
            </DisabledWarning>
          )}

          <FlexRow>
            <TextButton hoverColor="warn.alt" onClick={this.onCancelClick}>
              Cancel
            </TextButton>
            {!dataExists ? (
              <LoadingSelect />
            ) : (
              <RequiredSelector
                data-cy="composer-community-selector"
                onChange={this.setActiveCommunity}
                value={activeCommunity}
              >
                <option key={-1} value="">
                  Select community
                </option>
                {availableCommunities.map(community => {
                  return (
                    <option key={community.id} value={community.id}>
                      {community.name}
                    </option>
                  );
                })}
              </RequiredSelector>
            )}
            {!dataExists ? (
              <LoadingSelect />
            ) : (
              <RequiredSelector
                data-cy="composer-channel-selector"
                onChange={this.setActiveChannel}
                value={activeChannel}
              >
                <option key={-1} value="">
                  Select channel
                </option>
                {availableChannels
                  .filter(channel => channel.community.id === activeCommunity)
                  .map(channel => {
                    return (
                      <option key={channel.id} value={channel.id}>
                        {channel.name}
                      </option>
                    );
                  })}
              </RequiredSelector>
            )}
            <Button
              data-cy="composer-publish-button"
              onClick={this.publishThread}
              loading={isPublishing}
              disabled={
                !title ||
                title.trim().length === 0 ||
                !activeCommunity ||
                !activeChannel ||
                isPublishing ||
                networkDisabled
              }
              color={'brand'}
            >
              Publish
            </Button>
          </FlexRow>
        </Actions>
      </Container>
    );
  }
}

export const ThreadComposer = compose(
  getComposerCommunitiesAndChannels, // query to get data
  publishThread, // mutation to publish a thread
  withRouter // needed to use history.push() as a post-publish action
)(ComposerWithData);

const mapStateToProps = state => ({
  isOpen: state.composer.isOpen,
  threadSliderIsOpen: state.threadSlider.isOpen,
  websocketConnection: state.connectionStatus.websocketConnection,
  networkOnline: state.connectionStatus.networkOnline,
});

// $FlowIssue
const Composer = connect(mapStateToProps)(ThreadComposer);
export default Composer;
